// Ponto de entrada do bot.
//   MODO=envio  -> rodada normal de disparo (agendada pelo GitHub Actions)
//   MODO=login  -> mostra o QR Code, conecta o WhatsApp e preenche os IDs dos grupos
// Variáveis: GOOGLE_SA_JSON, PLANILHA_ID, FORCAR=1 (ignora horário/meta), DRY_RUN=1 (não envia nada)

import qrcodeTerminal from 'qrcode-terminal';
import QRCode from 'qrcode';
import { criarAuth, Planilha } from './planilha.js';
import { agoraSP, esperar, aleatorioEntre, lerDataBR } from './util.js';
import { enviadasUltimaHora, enviadasHoje, quantidadeDaRodada, escolherOfertas, resolverDestinos, filaNovas, repostaveis } from './selecao.js';
import { montarMensagem, sortearModelo } from './mensagem.js';
import { gerarArte, fotoDaLoja, fundoBranco } from './arte.js';
import { importarAchadinhos } from './importarCupons.js';
import { conectar, desconectar, localizarGrupos, lerCanais, enviarPost, enviarEnquete, SemSessaoError, DeslogadoError } from './whatsapp.js';
import { publicarStatus } from './status.js';
import { rodarHoraDoCupom } from './cupom.js';

const MODO = (process.env.MODO || 'envio').toLowerCase();
const FORCAR = ['1', 'true', 'sim'].includes(String(process.env.FORCAR || '').toLowerCase());
const DRY_RUN = ['1', 'true', 'sim'].includes(String(process.env.DRY_RUN || '').toLowerCase());

function resumoStatus(dados, agora, extra = {}) {
  const hoje = enviadasHoje(dados.log, agora.hojeTexto, lerDataBR);
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
    enquetes: (dados.enquetes || []).map((e) => ({ linha: e.linha, num: e.num, data: e.data, hora: e.hora, pergunta: e.pergunta, opcoes: e.opcoes, varias: e.varias, pronta: e.pronta, status: e.status, enviada_em: e.enviadaEm })),
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
  const corte = config.fimPorDia?.[agora.diaSemana];
  if (corte != null && agora.hora >= corte) return `${agora.diaSemana} encerra às ${corte}h (FIM_POR_DIA)`;
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

  const hoje = enviadasHoje(dados.log, agora.hojeTexto, lerDataBR);
  // Trava: nunca mais que postsPorExecucao (2) achadinhos em 60 minutos, mesmo com disparo manual.
  // Janela de 45 min (com 60 min de janela): como os horários são sorteados, o 2º post da rodada anterior
  // pode ter saído há 40–50 min; contar 60 min cortaria a rodada nova pela metade.
  // Disparo manual: trava de 2 a cada 45 min. Automático: nunca pula a rodada; só espera o respiro mínimo depois do último envio.
  const naHora = FORCAR ? enviadasUltimaHora(dados.log, agora.data, lerDataBR, config.janelaMin * 0.75 * 60_000) : 0;
  const livresNaHora = Math.max(0, config.postsPorExecucao - naHora);
  // Cadência fixa (INTERVALO_MIN, ex.: 25): cada rodada de hora manda quantos couberem até a próxima rodada.
  const cadencia = !FORCAR && config.intervaloMin > 0;
  const n = cadencia
    ? Math.max(0, Math.min(Math.ceil(60 / config.intervaloMin), config.postsPorDia - hoje.size))
    : Math.min(livresNaHora, FORCAR ? Math.max(1, config.postsPorExecucao) : quantidadeDaRodada(config, hoje.size));
  let ultimoEnvio = 0;
  for (const l of dados.log) { const d = l.resultado === 'OK' && lerDataBR(l.dataHora); if (d && d.getTime() > ultimoEnvio) ultimoEnvio = d.getTime(); }
  if (!n && naHora) {
    console.log(`Já saíram ${naHora} achadinho(s) na última hora. Esperando a próxima rodada.`);
    return status({ ultima_execucao: { modo: MODO, resultado: 'LIMITE_HORA', detalhe: `${naHora} na última hora` } });
  }
  const escolhidas = escolherOfertas(dados.ofertas, { n, agora: agora.data, config, hoje });
  console.log(`Hoje: ${hoje.size}/${config.postsPorDia}. Esta rodada: ${escolhidas.length} oferta(s).`);
  if (!escolhidas.length) {
    return status({ ultima_execucao: { modo: MODO, resultado: 'SEM_OFERTAS', detalhe: n ? 'fila vazia e nada para repostar' : 'meta do dia batida' } });
  }

  let sock = null;
  const inicioRodada = Date.now();
  let alvo = Math.max(inicioRodada, ultimoEnvio + config.intervaloMin * 60_000);
  if (!DRY_RUN && !cadencia && !FORCAR && config.atrasoInicialMaxSeg > 0) {
    const respiro = Math.ceil(config.pausaMinSeg - (Date.now() - ultimoEnvio) / 1000);
    const atraso = Math.max(aleatorioEntre(0, config.atrasoInicialMaxSeg), respiro);
    console.log(`Horário sorteado: 1º achadinho daqui a ${Math.round(atraso / 60)} min.`);
    await avisarProximo(status, '1º', atraso);
    await esperar(atraso * 1000);
  }
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
      if (cadencia && !DRY_RUN) {
        // Para antes de invadir a próxima rodada (que começa ~60 min depois desta).
        if (alvo > inicioRodada + 58 * 60_000) break;
        const falta = Math.max(0, Math.round((alvo - Date.now()) / 1000));
        if (falta > 0) {
          await avisarProximo(status, `${i + 1}º`, falta);
          // Espera em blocos de 1 min, conferindo a Hora do Cupom no meio do caminho.
          for (let fim = Date.now() + falta * 1000; Date.now() < fim;) {
            await esperar(Math.min(60_000, fim - Date.now()));
            try { await rodarHoraDoCupom(sock, planilha, dados); } catch (e) { console.log(`   ⚠️ cupom: ${e.message}`); }
        try { await achadinhosDoDia(sock, planilha, dados); } catch (e) { console.log(`   ⚠️ achadinhos: ${e.message}`); }
          }
        }
        alvo = Date.now() + config.intervaloMin * 60_000;
      } else if (i > 0) {
        const pausa = aleatorioEntre(config.pausaMinSeg, config.pausaMaxSeg);
        await avisarProximo(status, `${i + 1}º`, pausa);
        await esperar(pausa * 1000);
      }
      const corteHoje = config.fimPorDia?.[agoraSP().diaSemana];
      if (!FORCAR && corteHoje != null && agoraSP().hora >= corteHoje) {
        console.log(`Passou das ${corteHoje}h (FIM_POR_DIA): parando a rodada.`);
        break;
      }
      if (!DRY_RUN) {
        try { await rodarHoraDoCupom(sock, planilha, dados); } catch (e) { console.log(`   ⚠️ cupom: ${e.message}`); }
        try { await achadinhosDoDia(sock, planilha, dados); } catch (e) { console.log(`   ⚠️ achadinhos: ${e.message}`); }
        for (const enq of enquetesVencidas(dados)) {
          try { await mandarEnquete(sock, planilha, dados, enq); } catch (e) { console.log(`   ⚠️ enquete: ${e.message}`); }
          await esperar(aleatorioEntre(30, 60) * 1000);
        }
      }
      const texto = montarMensagem(sortearModelo(dados.modelos), oferta);
      let imagem = null;
      let avisoImagem = '';
      try {
        imagem = await planilha.baixarImagem(oferta.imagem);
      } catch (e) {
        avisoImagem = `sem imagem (${e.message}); enviado só texto`;
      }
      if (!imagem) {
        // sem imagem na planilha: cria a arte na hora, com o preço "Por" atual
        try {
          const foto = await fotoDaLoja(oferta.link);
          if (foto && await fundoBranco(foto)) { imagem = await gerarArte({ foto, preco: oferta.precoPor }); avisoImagem = 'arte criada automaticamente'; }
        } catch (e) { console.log(`   ⚠️ arte: ${e.message}`); }
      }
      if (!imagem && !DRY_RUN) {
        // sem foto boa: não lança; sinaliza na planilha pra alguém colocar a imagem
        console.log(`   ⚠️ Linha ${oferta.linha}: sem foto de fundo branco — marcada ATENÇÃO`);
        if (colunas.status) await planilha.escreverCelulas([{ range: `Ofertas!${colunas.status}${oferta.linha}`, valor: 'ATENÇÃO: SEM FOTO' }]);
        continue;
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
      // Grava na planilha logo depois de cada achadinho (não só no fim da rodada).
      try {
        await planilha.escreverCelulas(escrita);
        escrita.length = 0;
        await planilha.anexarLog(log);
        log.length = 0;
      } catch (e) {
        console.log(`   ⚠️ não consegui gravar na planilha agora: ${e.message}`);
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

// Envia uma enquete para os destinos ativos usando uma conexão já aberta; marca na planilha.
/** Uma vez por dia: traz os achadinhos novos dos canais de referência (inativos). */
async function achadinhosDoDia(sock, planilha, dados) {
  const marca = 'IMPORTAR ACHADINHOS';
  const hoje = agoraSP().hojeTexto;
  if (dados.log.some((l) => l.produto === marca && l.dataHora.startsWith(hoje))) return;
  const n = await importarAchadinhos(sock, planilha, dados, { limite: 40 });
  const linha = [agoraSP().dataHoraSegTexto, '', marca, '', 'IMPORTADO', `${n} achadinho(s)`];
  await planilha.anexarLog([linha]);
  dados.log.push({ dataHora: linha[0], produto: marca, resultado: 'IMPORTADO' });
}

async function mandarEnquete(sock, planilha, dados, enquete, destinosTeste = null) {
  const destinos = (destinosTeste || dados.grupos.filter((g) => g.ativo && g.jid));
  console.log(`\n📊 Enquete: ${enquete.pergunta} -> ${destinos.length} destino(s)`);
  const log = [];
  let ok = 0;
  for (const [i, g] of destinos.entries()) {
    if (i > 0) await esperar(aleatorioEntre(dados.config.pausaDestinoMinSeg, dados.config.pausaDestinoMaxSeg) * 1000);
    try {
      await enviarPost(sock, g.jid, { texto: '📊 *ENQUETE ASSOPRA FITAS* 📼\n\n_Vota aí, rapaziada!_ 👇' });
      await esperar(3000);
      await enviarEnquete(sock, g.jid, enquete);
      ok++;
      log.push([agoraSP().dataHoraSegTexto, '', `Enquete: ${enquete.pergunta}`, g.nome, 'ENQUETE', '']);
      console.log(`   ✅ ${g.nome}`);
    } catch (e) {
      log.push([agoraSP().dataHoraSegTexto, '', `Enquete: ${enquete.pergunta}`, g.nome, 'ERRO', e.message]);
      console.log(`   ❌ ${g.nome}: ${e.message}`);
    }
  }
  if (enquete.teste) return ok;
  await planilha.anexarLog(log);
  if (enquete.linha && ok) {
    enquete.status = 'ENVIADA';
    await planilha.escreverCelulas([
      { range: `Enquetes!H${enquete.linha}`, valor: 'ENVIADA' },
      { range: `Enquetes!I${enquete.linha}`, valor: agoraSP().dataHoraTexto },
    ]);
  }
  return ok;
}

/** Enquetes marcadas como prontas cuja data/hora já chegou. */
function enquetesVencidas(dados) {
  const agora = Date.now();
  return (dados.enquetes || []).filter((e) => {
    if (!e.pronta || e.status === 'ENVIADA' || !/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(e.data)) return false;
    const quando = lerDataBR(`${e.data} ${e.hora || '12:00'}`.trim());
    return quando && quando.getTime() <= agora;
  });
}

// Botão "Enviar" do painel: linha da aba Enquetes, ou pergunta avulsa em JSON.
async function modoEnquete(planilha, dados) {
  const pedido = String(process.env.ENQUETE || '').trim();
  let enquete;
  if (pedido.startsWith('{')) {
    const j = JSON.parse(pedido);
    enquete = { linha: 0, pergunta: String(j.pergunta || '').trim(), opcoes: (j.opcoes || []).map(String).filter(Boolean), varias: Boolean(j.varias) };
  } else {
    enquete = dados.enquetes.find((e) => e.linha === Number(pedido));
  }
  if (!enquete?.pergunta || enquete.opcoes.length < 2) throw new Error('Enquete inválida: precisa de pergunta e pelo menos 2 opções.');
  const { sock } = await conectar();
  let ok = 0;
  try {
    const link = String(process.env.DESTINO || '').trim();
    let teste = null;
    if (link) {
      const cod = link.split('/').pop();
      const meta = await sock.newsletterMetadata('invite', cod);
      teste = [{ nome: 'TESTE', jid: meta.id, ativo: true }];
      enquete = { ...enquete, teste: true };
    }
    ok = await mandarEnquete(sock, planilha, dados, enquete, teste);
  } finally {
    await desconectar(sock);
    Object.assign(dados, await planilha.carregar());
    await publicarStatus(resumoStatus(dados, agoraSP(), { whatsapp: 'CONECTADO', ultima_execucao: { modo: 'enquete', resultado: ok ? 'OK' : 'ERRO', detalhe: `enquete em ${ok} destino(s)` } }));
  }
}

// Painel "Editar": grava a enquete na planilha (não usa o WhatsApp).
async function modoEditarEnquete(planilha, dados) {
  const j = JSON.parse(process.env.ENQUETE || '{}');
  const opcoes = (j.opcoes || []).map((o) => String(o).trim()).filter(Boolean);
  if (!String(j.pergunta || '').trim() || opcoes.length < 2) throw new Error('Precisa de pergunta e pelo menos 2 opções.');
  let linha = Number(j.linha) || 0;
  if (!linha) linha = Math.max(1, ...dados.enquetes.map((e) => e.linha)) + 1;
  const num = dados.enquetes.find((e) => e.linha === linha)?.num || String(linha - 1).padStart(2, '0');
  await planilha.escreverCelulas([
    { range: `Enquetes!A${linha}`, valor: num },
    { range: `Enquetes!B${linha}`, valor: String(j.data || '') },
    { range: `Enquetes!C${linha}`, valor: String(j.hora || '') },
    { range: `Enquetes!D${linha}`, valor: String(j.pergunta).trim() },
    { range: `Enquetes!E${linha}`, valor: opcoes.join(' | ') },
    { range: `Enquetes!F${linha}`, valor: j.varias ? 'TRUE' : 'FALSE' },
    { range: `Enquetes!G${linha}`, valor: j.pronta ? 'TRUE' : 'FALSE' },
  ]);
  console.log(`Enquete salva na linha ${linha}.`);
  Object.assign(dados, await planilha.carregar());
  await publicarStatus(resumoStatus(dados, agoraSP(), { whatsapp: 'CONECTADO', ultima_execucao: { modo: 'enquete', resultado: 'OK', detalhe: 'enquete salva' } }));
}

async function main() {
  const agora = agoraSP();
  const planilha = new Planilha(criarAuth(), process.env.PLANILHA_ID);
  const dados = await planilha.carregar();
  console.log(`Achadinhos bot | modo=${MODO}${FORCAR ? ' forçado' : ''}${DRY_RUN ? ' teste' : ''} | ${agora.dataHoraTexto} (${agora.diaSemana})`);
  if (MODO === 'login') await modoLogin(planilha, dados, agora);
  else if (MODO === 'grupos') await modoGrupos(planilha, dados);
  else if (MODO === 'enquete') await modoEnquete(planilha, dados);
  else if (MODO === 'editar-enquete') await modoEditarEnquete(planilha, dados);
  else await modoEnvio(planilha, dados, agora);
}

main().then(
  () => process.exit(0),
  (e) => { console.error(e?.stack || e); process.exit(1); },
);

/** Mostra no painel o horário sorteado do próximo achadinho. */
async function avisarProximo(status, qual, segundos) {
  const hora = new Date(Date.now() + segundos * 1000)
    .toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
  try {
    await status({ ultima_execucao: { modo: 'envio', resultado: `⏳ ${qual} achadinho às ${hora}`, detalhe: '' } });
  } catch { /* painel é opcional */ }
}
