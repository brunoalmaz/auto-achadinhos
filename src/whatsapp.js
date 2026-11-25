// Conexão com o WhatsApp (Baileys) e localização dos grupos/comunidade.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  proto,
  generateMessageID,
} from 'baileys';
import { createHash } from 'node:crypto';
import pino from 'pino';
import { normalizar, esperar } from './util.js';

export class SemSessaoError extends Error {}
export class DeslogadoError extends Error {}

/**
 * Conecta usando a sessão salva na pasta `auth/`.
 * - modoLogin=false: se não houver sessão válida, falha com SemSessaoError (não mostra QR).
 * - modoLogin=true: chama onQR(qr) a cada QR novo até a pessoa ler com o celular.
 */
export async function conectar({ pasta = 'auth', modoLogin = false, onQR, timeoutMs = 120_000 } = {}) {
  const { state, saveCreds } = await useMultiFileAuthState(pasta);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    version = undefined; // usa a versão embutida no Baileys
  }
  const logger = pino({ level: process.env.LOG_WA || 'warn' });

  return new Promise((resolve, reject) => {
    let tentativas = 0;
    let terminou = false;
    const fim = (fn, v) => { if (!terminou) { terminou = true; clearTimeout(timer); fn(v); } };
    const timer = setTimeout(() => fim(reject, new Error('Tempo esgotado conectando ao WhatsApp')), timeoutMs);

    const iniciar = () => {
      const sock = makeWASocket({
        version,
        auth: state,
        logger,
        browser: Browsers.ubuntu('Achadinhos Bot'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        generateHighQualityLinkPreview: false,
      });
      sock.ev.on('creds.update', saveCreds);
      sock.ev.on('connection.update', (u) => {
        if (u.qr) {
          if (!modoLogin) {
            sock.end(undefined);
            fim(reject, new SemSessaoError('WhatsApp sem sessão: rode o workflow "Conectar WhatsApp" e leia o QR Code.'));
            return;
          }
          onQR?.(u.qr);
        }
        if (u.connection === 'open') fim(resolve, { sock, saveCreds });
        if (u.connection === 'close' && !terminou) {
          const codigo = u.lastDisconnect?.error?.output?.statusCode;
          if (codigo === DisconnectReason.loggedOut) {
            fim(reject, new DeslogadoError('WhatsApp deslogado (aparelho removido no celular). Conecte de novo.'));
            return;
          }
          // 515 (restartRequired) é normal logo depois de ler o QR.
          if (tentativas++ < 4) setTimeout(iniciar, codigo === DisconnectReason.restartRequired ? 500 : 3000);
          else fim(reject, new Error(`WhatsApp fechou a conexão (código ${codigo ?? '?'})`));
        }
      });
    };
    iniciar();
  });
}

export async function desconectar(sock) {
  await esperar(4000); // dá tempo das mensagens saírem e das chaves serem salvas
  try { sock.end(undefined); } catch { /* ignora */ }
}

/**
 * Procura no WhatsApp os grupos da aba Grupos pelo nome e devolve o ID (jid) de cada um.
 * Para COMUNIDADE, devolve o grupo de avisos da comunidade.
 */
export async function localizarGrupos(sock, grupos) {
  const todos = Object.values(await sock.groupFetchAllParticipating());
  const achados = [];
  for (const g of grupos) {
    const alvo = normalizar(g.nome);
    let meta = null;
    if (g.tipo === 'COMUNIDADE') {
      const pai = todos.find((m) => m.isCommunity && normalizar(m.subject) === alvo);
      meta = (pai && todos.find((m) => m.isCommunityAnnounce && m.linkedParent === pai.id))
        || todos.find((m) => m.isCommunityAnnounce && normalizar(m.subject) === alvo);
    } else {
      meta = todos.find((m) => !m.isCommunity && normalizar(m.subject) === alvo);
    }
    achados.push({ ...g, jidEncontrado: meta?.id || '' });
  }
  // Lista do que dá pra postar: grupos comuns e o grupo de avisos de cada comunidade
  // (a comunidade em si não recebe mensagem; quem recebe é o grupo de avisos dela).
  const porId = Object.fromEntries(todos.map((m) => [m.id, m]));
  const disponiveis = todos
    .filter((m) => !m.isCommunity)
    .map((m) => (m.isCommunityAnnounce
      ? { nome: porId[m.linkedParent]?.subject || m.subject, tipo: 'COMUNIDADE', id: m.id }
      : { nome: m.subject, tipo: 'GRUPO', id: m.id }))
    .sort((a, b) => a.tipo.localeCompare(b.tipo) || a.nome.localeCompare(b.nome, 'pt-BR'));
  return { achados, disponiveis };
}

/**
 * Canais do WhatsApp: o WhatsApp não deixa listar, então o bot acha cada canal pelo link
 * (whatsapp.com/channel/CODIGO). Só dá pra postar se o número for admin/dono do canal.
 */
export async function lerCanais(sock, links) {
  const canais = [];
  for (const link of links) {
    const codigo = String(link).match(/channel\/([\w-]+)/)?.[1] || String(link).trim();
    if (!codigo) continue;
    try {
      const m = await sock.newsletterMetadata('invite', codigo);
      if (!m?.id) throw new Error('canal não encontrado');
      let papel = String(m.viewer_metadata?.role || '').toUpperCase();
      if (!papel) {
        try { papel = String((await sock.newsletterMetadata('jid', m.id))?.viewer_metadata?.role || '').toUpperCase(); } catch { /* segue sem papel */ }
      }
      const nome = String(m.thread_metadata?.name?.text || m.name || codigo).trim();
      // Sem papel informado, o canal entra mesmo assim: se o número não for admin, o envio falha e aparece no Log.
      const bloqueado = ['SUBSCRIBER', 'GUEST'].includes(papel);
      console.log(`  ${bloqueado ? '⚠️ ' : '✅'} Canal "${nome}" (${papel || 'papel não informado'})${bloqueado ? ' — o número só segue o canal; precisa ser admin pra postar' : ''}`);
      if (!bloqueado) canais.push({ nome, tipo: 'CANAL', id: m.id });
    } catch (e) {
      console.log(`  ❌ Canal ${codigo}: ${e.message}`);
    }
  }
  return canais;
}

export async function enviarPost(sock, jid, { texto, imagem }) {
  if (imagem && jid.endsWith('@newsletter')) return enviarImagemCanal(sock, jid, imagem, texto);
  if (imagem) return sock.sendMessage(jid, { image: imagem, caption: texto });
  return sock.sendMessage(jid, { text: texto });
}

function tipoImagem(buf) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf[0] === 0x52 && buf[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

/**
 * Canal (newsletter): a imagem precisa subir no caminho próprio de canal
 * (/newsletter/newsletter-image) e a mensagem leva o "media_id" devolvido.
 * Sem isso o WhatsApp descarta a imagem em silêncio.
 */
async function enviarImagemCanal(sock, jid, imagem, legenda) {
  const buf = Buffer.isBuffer(imagem) ? imagem : Buffer.from(imagem);
  const sha = createHash('sha256').update(buf).digest();
  const token = sha.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  let info = await sock.refreshMediaConn(false);
  let resp = null;
  for (const { hostname } of info.hosts) {
    const url = `https://${hostname}/newsletter/newsletter-image/${token}?auth=${encodeURIComponent(info.auth)}&token=${token}`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        body: buf,
        headers: { 'Content-Type': 'application/octet-stream', Origin: 'https://web.whatsapp.com' },
      });
      const j = await r.json();
      if (j?.direct_path || j?.url) { resp = j; break; }
      info = await sock.refreshMediaConn(true);
    } catch { /* tenta o próximo host */ }
  }
  if (!resp) throw new Error('upload da imagem do canal falhou');
  const msg = proto.Message.fromObject({
    imageMessage: {
      url: resp.url,
      directPath: resp.direct_path,
      mimetype: tipoImagem(buf),
      fileSha256: sha,
      fileLength: buf.length,
      caption: legenda || undefined,
    },
  });
  const id = generateMessageID();
  // O Baileys não põe o atributo "mediatype" no nó do canal; o servidor recusa (erro 479). Montamos na mão.
  await sock.sendNode({
    tag: 'message',
    attrs: { to: jid, id, type: 'media', ...(resp.handle ? { media_id: resp.handle } : {}) },
    content: [{ tag: 'plaintext', attrs: { mediatype: 'image' }, content: proto.Message.encode(msg).finish() }],
  });
  return { key: { id, remoteJid: jid } };
}
