// Ponto de entrada do bot.
//   MODO=envio  -> rodada normal de disparo (agendada pelo GitHub Actions)
//   MODO=login  -> mostra o QR Code, conecta o WhatsApp e preenche os IDs dos grupos
// Variáveis: GOOGLE_SA_JSON, PLANILHA_ID, FORCAR=1 (ignora horário/meta), DRY_RUN=1 (não envia nada)

import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { criarAuth, Planilha } from './planilha.js';
import { agoraSP, esperar, aleatorioEntre } from './util.js';
import { enviadasHoje, quantidadeDaRodada, escolherOfertas, resolverDestinos, filaNovas, repostaveis } from './selecao.js';
import { montarMensagem, sortearModelo } from './mensagem.js';
import { conectar, desconectar, localizarGrupos, lerCanais, enviarPost, SemSessaoError, DeslogadoError } from './whatsapp.js';
import { publicarStatus } from './status.js';

const MODO = (process.env.MODO || 'envio').toLowerCase();
const FORCAR = ['1', 'true', 'sim'].includes(String(process.env.FORCAR || '').toLowerCase());
const DRY_RUN = ['1', 'true', 'sim'].includes(String(process.env.DRY_RUN || '').toLowerCase());

function resumoStatus(dados, agora, extra = {}) {
  const hoje = enviadasHoje(dados.log, agora.hojeTexto);
  return {
    atualizado_em: agora.dataHoraSegTexto,
    sistema: dados.config.sistema,
    whatsapp: 'DESCONHECIDO',
    qr: null,
    enviados_hoje: hoje.size,
    meta_dia: dados.config.postsPorDia,
    horario: `${dados.config.horaInicio}h às ${dados.config.horaFim}h`,
    dias: dados.config.dias.join(','),
    fila_novas: filaNovas(dados.ofertas).length,
    repost_disponiveis: repostaveis(dados.ofertas, {
      agora: agora.data,
      repostHoras: dados.config.repostHoras,
      repostValidadeDias: dados.config.repostValidadeDias,
      hoje,
    }).length,
    grupos: dados.grupos.map((g) => ({ nome: g.nome, tipo: g.tipo, ativo: g.ativo, conectado: Boolean(g.jid), id: g.jid })),
    disponiveis: dados.disponiveis || [],
    ultimos_envios: dados.log.slice(-15).reverse(),
    ultima_execucao: { modo: MODO, resultado: 'OK', detalhe: '' },
    ...extra,
  };
}

async function sincronizarGrupos(sock, planilha, grupos, dados) {
  const { achados, disponiveis: soGrupos } = await localizarGrupos(sock, grupos);
  const canais = dados?.config?.canais?.length ? await lerCanais(sock, dados.config.canais) : [];
  const disponiveis = [...canais, ...soGrupos];
  await planilha.gravarDisponiveis(disponiveis, agoraSP().dataHoraTexto);
  if (dados) dados.disponiveis = disponiveis;
  const escrita = [];
  for (const g of achados) {
    if (g.jidEncontrado && g.jidEncontrado !== g.jid) {
      escrita.push({ range: `Grupos!C${g.linha}`, valor: g.jidEncontrado });
      g.jid = g.jidEncontrado;
    }
  }
  await planilha.escreverCelulas(escrita);
  const faltando = achados.filter((g) => g.ativo && !g.jid);
  if (faltando.length) {
    console.log('\n⚠️  Não achei estes grupos pelo nome:', faltando.map((g) => g.nome).join(', '));
    console.log('Grupos que este número participa (copie o nome exato para a aba Grupos):');
    for (const d of disponiveis) console.log(`  - [${d.tipo}] ${d.nome}  ->  ${d.id}`);
  }
  return achados;
}

async function modoLogin(planilha, dados, agora) {
  const canalNovo = String(process.env.CANAL || '').trim();
  if (canalNovo) {
    console.log(`Adicionando canal: ${canalNovo}`);
    dados.config.canais = await planilha.adicionarCanal(canalNovo);
  }
  console.log('Gerando QR Code. No celular: WhatsApp > Aparelhos conectados > Conectar aparelho.\n');
  const { sock } = await conectar({
    modoLogin: true,
    timeoutMs: 5 * 60_000,
    onQR: async (qr) => {
      qrcodeTerminal.generate(qr, { small: true });
      console.log('(o QR muda a cada ~20 segundos; também aparece no painel)\n');
      await publicarStatus(resumoStatus(dados, agora, {
        whatsapp: 'AGUARDANDO_QR',
        qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }),
      }));
    },
  });
  console.log('✅ WhatsApp conectado. Procurando os grupos...');
  await esperar(3000);
  const grupos = await sincronizarGrupos(sock, planilha, dados.grupos, dados);
  for (const g of grupos) console.log(`  ${g.jid ? '✅' : '❌'} ${g.nome} ${g.jid}`);
  dados.grupos = grupos;
  await publicarStatus(resumoStatus(dados, agoraSP(), { whatsapp: 'CONECTADO' }));
  await desconectar(sock);
}

function dentroDoHorario(config, agora) {
  if (!config.dias.includes(agora.diaSemana)) return `hoje (${agora.diaSemana}) não está em DIAS_SEMANA`;
  if (agora.hora < config.horaInicio || agora.hora > config.horaFim) {
    return `fora do horário (${agora.hora}h; janela ${config.horaInicio}h-${config.horaFim}h)`;
  }
  return null;
}

async function modoEnvio(planilha, dados, agora) {
  const { config } = dados;
  const status = (extra) => publicarStatus(resumoStatus(dados, agora, extra));

  if (config.sistema !== 'ATIVO' && !FORCAR) {
    console.log('Sistema PAUSADO na aba Config. Nada a fazer.');
    return status({ ultima_execucao: { modo: MODO, resultado: 'PAUSADO', detalhe: '' } });
  }
  const motivoHorario = dentroDoHorario(config, agora);
  if (motivoHorario && !FORCAR) {
    console.log(`Nada a fazer: ${motivoHorario}.`);
    return status({ ultima_execucao: { modo: MODO, resultado: 'FORA_DO_HORARIO', detalhe: motivoHorario } });
  }

  const hoje = enviadasHoje(dados.log, agora.hojeTexto);
  const n = FORCAR ? Math.max(1, config.postsPorExecucao) : quantidadeDaRodada(config, hoje.size);
  const escolhidas = escolherOfertas(dados.ofertas, { n, agora: agora.data, config, hoje });
  console.log(`Hoje: ${hoje.size}/${config.postsPorDia}. Esta rodada: ${escolhidas.length} oferta(s).`);
  if (!escolhidas.length) {
    return status({ ultima_execucao: { modo: MODO, resultado: 'SEM_OFERTAS', detalhe: n ? 'fila vazia e nada para repostar' : 'meta do dia batida' } });
  }

  let sock = null;
  if (!DRY_RUN) {
    try {
      ({ sock } = await conectar());
    } catch (e) {
      const desconectado = e instanceof SemSessaoError || e instanceof DeslogadoError;
      await status({ whatsapp: 'DESCONECTADO', ultima_execucao: { modo: MODO, resultado: 'ERRO', detalhe: e.message } });
      if (desconectado) console.error(`\n❌ ${e.message}`);
      throw e;
    }
    if (dados.grupos.some((g) => g.ativo && !g.jid)) {
      dados.grupos = await sincronizarGrupos(sock, planilha, dados.grupos, dados);
    }
  }

  const escrita = [];
  const log = [];
  const { colunas } = dados;
  try {
    for (const [i, oferta] of escolhidas.entries()) {
      if (i > 0) await esperar(aleatorioEntre(config.pausaMinSeg, config.pausaMaxSeg) * 1000);
      const texto = montarMensagem(sortearModelo(dados.modelos), oferta);
      let imagem = null;
      let avisoImagem = '';
      try {
        imagem = await planilha.baixarImagem(oferta.imagem);
      } catch (e) {
        avisoImagem = `sem imagem (${e.message}); enviado só texto`;
      }
      const { destinos, desconhecidos } = resolverDestinos(oferta.destino, dados.grupos);
      const momento = () => agoraSP().dataHoraSegTexto;
      for (const nome of desconhecidos) log.push([momento(), oferta.linha, oferta.produto, nome, 'ERRO', 'destino não existe na aba Grupos']);

      console.log(`\n— Linha ${oferta.linha}${oferta.repost ? ' (repost)' : ''}: ${oferta.produto}`);
      if (DRY_RUN) console.log(texto.split('\n').map((l) => `    ${l}`).join('\n'));

      let okCount = 0;
      for (const [j, g] of destinos.entries()) {
        if (j > 0) await esperar(aleatorioEntre(config.pausaDestinoMinSeg, config.pausaDestinoMaxSeg) * 1000);
        if (!g.jid && !DRY_RUN) {
          log.push([momento(), oferta.linha, oferta.produto, g.nome, 'ERRO', 'grupo sem ID (rode "Conectar WhatsApp")']);
          continue;
        }
        try {
          if (!DRY_RUN) await enviarPost(sock, g.jid, { texto, imagem });
          okCount++;
          const det = [oferta.repost ? 'repost' : 'nova', avisoImagem].filter(Boolean).join('; ');
          log.push([momento(), oferta.linha, oferta.produto, g.nome, 'OK', DRY_RUN ? `teste: ${det}` : det]);
          console.log(`   ✅ ${g.nome}${avisoImagem ? ' (só texto)' : ''}`);
        } catch (e) {
          log.push([momento(), oferta.linha, oferta.produto, g.nome, 'ERRO', e.message]);
          console.log(`   ❌ ${g.nome}: ${e.message}`);
        }
      }

      if (DRY_RUN) continue;
      if (colunas.status) escrita.push({ range: `Ofertas!${colunas.status}${oferta.linha}`, valor: okCount ? 'ENVIADO' : 'ERRO' });
      if (okCount) {
        if (colunas.ultimoEnvio) escrita.push({ range: `Ofertas!${colunas.ultimoEnvio}${oferta.linha}`, valor: agoraSP().dataHoraTexto });
        if (colunas.qtdEnvios) escrita.push({ range: `Ofertas!${colunas.qtdEnvios}${oferta.linha}`, valor: oferta.qtdEnvios + 1 });
      }
    }
  } finally {
    if (sock) await desconectar(sock);
    if (!DRY_RUN) {
      await planilha.escreverCelulas(escrita);
      await planilha.anexarLog(log);
    }
  }

  if (DRY_RUN) {
    console.log('\n(DRY_RUN: nada foi enviado nem gravado na planilha)');
    return;
  }
  const novo = await planilha.carregar();
  Object.assign(dados, novo);
  const erros = log.filter((l) => l[4] === 'ERRO').length;
  await publicarStatus(resumoStatus(dados, agoraSP(), {
    whatsapp: 'CONECTADO',
    ultima_execucao: { modo: MODO, resultado: erros ? 'COM_ERROS' : 'OK', detalhe: `${log.length - erros} envio(s) ok, ${erros} erro(s)` },
  }));
}

// Salva na aba Grupos a seleção feita no painel (não conecta no WhatsApp).
async function modoGrupos(planilha, dados) {
  let selecao;
  try {
    selecao = JSON.parse(process.env.SELECAO || '[]');
  } catch {
    throw new Error('SELECAO inválida (esperado JSON).');
  }
  const validos = new Map(dados.disponiveis.map((d) => [d.id, d]));
  const escolhidos = selecao.map((id) => validos.get(id)).filter(Boolean);
  console.log(`Salvando ${escolhidos.length} destino(s):`);
  for (const g of escolhidos) console.log(`  - [${g.tipo}] ${g.nome}`);
  await planilha.gravarGrupos(escolhidos);
  Object.assign(dados, await planilha.carregar());
  await publicarStatus(resumoStatus(dados, agoraSP(), { whatsapp: 'CONECTADO', ultima_execucao: { modo: MODO, resultado: 'OK', detalhe: `${escolhidos.length} destino(s) salvos` } }));
}

async function main() {
  const agora = agoraSP();
  const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
  const dados = await planilha.carregar();
  console.log(`Achadinhos bot | modo=${MODO}${FORCAR ? ' forçado' : ''}${DRY_RUN ? ' teste' : ''} | ${agora.dataHoraTexto} (${agora.diaSemana})`);
  if (MODO === 'login') await modoLogin(planilha, dados, agora);
  else if (MODO === 'grupos') await modoGrupos(planilha, dados);
  else await modoEnvio(planilha, dados, agora);
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e?.stack || e); process.exit(1); },
);
