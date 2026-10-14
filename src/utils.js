import fs from 'fs';

/**
 * Extrai códigos de convite de grupo do WhatsApp a partir de texto ou lista de links.
 * Suporta formatos:
 * - https://chat.whatsapp.com/CODE
 * - https://chat.whatsapp.com/invite/CODE
 * - chat.whatsapp.com/CODE
 * @param {string} text 
 * @returns {Array<{code: string, url: string}>}
 */
export function extractInviteCodes(text) {
  if (!text || typeof text !== 'string') return [];
  
  // Regex aprimorada para capturar links de grupos do WhatsApp (suporta invite/, www, queries e códigos de 18 a 34 chars)
  const regex = /(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]{18,34})/gi;
  const matches = [];
  const seenCodes = new Set();

  let match;
  while ((match = regex.exec(text)) !== null) {
    const code = match[1];
    // Evita falsos positivos com palavras reservadas
    if (code.toLowerCase() === 'invite' || code.toLowerCase() === 'channel') continue;
    if (!seenCodes.has(code)) {
      seenCodes.add(code);
      matches.push({
        code: code,
        url: `https://chat.whatsapp.com/${code}`
      });
    }
  }

  return matches;
}

/**
 * Gera um tempo de atraso aleatório em milissegundos entre minSec e maxSec.
 * @param {number} minSec 
 * @param {number} maxSec 
 * @returns {number} milissegundos
 */
export function getRandomDelay(minSec = 20, maxSec = 50) {
  const minMs = minSec * 1000;
  const maxMs = maxSec * 1000;
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Pausa a execução por ms milissegundos.
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Formata uma data para a representação local brasileira (DD/MM/YYYY HH:mm:ss).
 * @param {Date|number|string} dateInput 
 * @returns {string}
 */
export function formatDate(dateInput) {
  const date = new Date(dateInput);
  return date.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
