// Gera o status.json (lido pelo painel) e, se configurado, publica no repositório do painel.
//
// O repositório do painel é PÚBLICO (exigência do GitHub Pages grátis). Por isso o status
// é criptografado com PANEL_SENHA (AES-256-GCM, chave derivada por PBKDF2-SHA256).
// Sem senha configurada, o bot NÃO publica o QR Code, só o resto do status.

import { writeFile } from 'node:fs/promises';
import { randomBytes, pbkdf2Sync, createCipheriv } from 'node:crypto';

export const ITERACOES = 200_000;

/** Formato compatível com WebCrypto: dados = ciphertext + tag (16 bytes), tudo base64. */
export function criptografar(objeto, senha) {
  const sal = randomBytes(16);
  const iv = randomBytes(12);
  const chave = pbkdf2Sync(senha, sal, ITERACOES, 32, 'sha256');
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([c.update(JSON.stringify(objeto), 'utf8'), c.final(), c.getAuthTag()]);
  return {
    v: 1,
    alg: 'AES-256-GCM/PBKDF2-SHA256',
    iteracoes: ITERACOES,
    sal: sal.toString('base64'),
    iv: iv.toString('base64'),
    dados: cifrado.toString('base64'),
  };
}

export async function publicarStatus(status) {
  await writeFile('status.json', JSON.stringify(status, null, 2));

  const token = process.env.PANEL_TOKEN;
  const repo = process.env.PANEL_REPO || "brunoalmaz/achadinhos-painel";
  if (!token || !repo) return;

  const senha = process.env.PANEL_SENHA;
  const publico = senha
    ? { atualizado_em: status.atualizado_em, criptografado: criptografar(status, senha) }
    : { ...status, qr: null, aviso: 'Configure o secret PANEL_SENHA para ver o QR Code no painel.' };
  const json = JSON.stringify(publico, null, 2);

  const url = `https://api.github.com/repos/${repo}/contents/status.json`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  try {
    let sha;
    const atual = await fetch(url, { headers });
    if (atual.ok) sha = (await atual.json()).sha;
    const r = await fetch(url, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        message: `status ${status.atualizado_em}`,
        content: Buffer.from(json).toString('base64'),
        sha,
      }),
    });
    if (!r.ok) console.warn(`Aviso: não consegui publicar o status no painel (HTTP ${r.status}).`);
  } catch (e) {
    console.warn('Aviso: falha ao publicar status no painel:', e.message);
  }
}
