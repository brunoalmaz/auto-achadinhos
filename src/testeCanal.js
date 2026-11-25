// Teste de envio para um canal (newsletter). Uso: CANAL=<link> node src/testeCanal.js
import QRCode from 'qrcode';
import { conectar, desconectar, enviarPost } from './whatsapp.js';
import { esperar } from './util.js';

const link = process.env.CANAL || '';
const codigo = link.match(/channel\/([\w-]+)/)?.[1] || link.trim();
if (!codigo) throw new Error('Informe o link do canal');

const { sock } = await conectar();
try {
  const m = await sock.newsletterMetadata('invite', codigo);
  const jid = m?.id;
  console.log('Canal:', jid, 'papel:', m?.viewer_metadata?.role || '?');
  const img = await QRCode.toBuffer('Assopra Fitas - teste', { width: 600 });
  const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const testes = [
    ['4 imagem+legenda (corrigido)', { imagem: img, texto: `Teste 4 (${hora}): imagem com legenda, envio corrigido` }],
  ];
  for (const [nome, conteudo] of testes) {
    try {
      const r = await enviarPost(sock, jid, conteudo);
      console.log(`✅ ${nome}: id ${r?.key?.id}`);
    } catch (e) {
      console.log(`❌ ${nome}: ${e.message}`);
    }
    await esperar(5000);
  }
} finally {
  await desconectar(sock);
}
