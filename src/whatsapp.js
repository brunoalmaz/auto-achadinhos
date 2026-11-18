// Conexão com o WhatsApp (Baileys) e localização dos grupos/comunidade.

import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from 'baileys';
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
  const disponiveis = todos.map((m) => ({
    nome: m.subject,
    tipo: m.isCommunity ? 'COMUNIDADE' : m.isCommunityAnnounce ? 'AVISOS DA COMUNIDADE' : 'GRUPO',
    id: m.id,
  }));
  return { achados, disponiveis };
}

export async function enviarPost(sock, jid, { texto, imagem }) {
  if (imagem) return sock.sendMessage(jid, { image: imagem, caption: texto });
  return sock.sendMessage(jid, { text: texto });
}
