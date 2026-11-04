// Gemeinsame Krypto-Funktionen (Node >= 20, WebCrypto – identisch zur Browser-Seite).
//
// Aufbau:
//   keys.json   – öffentlicher RSA-Schlüssel + privater Schlüssel, je Passwort einmal
//                 verschlüsselt (PBKDF2-SHA256 -> AES-256-GCM). Nur der Browser entpackt ihn.
//   *.enc       – Bericht: zufälliger AES-256-GCM-Schlüssel, mit RSA-OAEP verpackt.
// Die tägliche Routine braucht nur den öffentlichen Schlüssel, also kein Geheimnis.

const { subtle } = globalThis.crypto;

export const b64 = (buf) => Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf).toString('base64');
export const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

const RSA = { name: 'RSA-OAEP', hash: 'SHA-256' };

export async function encryptReport(publicKeyB64, obj) {
  const pub = await subtle.importKey('spki', unb64(publicKeyB64), RSA, false, ['encrypt']);
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain);
  const key = await subtle.encrypt(RSA, pub, await subtle.exportKey('raw', aes));
  return { v: 1, key: b64(key), iv: b64(iv), data: b64(data) };
}

// Nur für lokale Tests: Schlüsselpaar mit einem Passwort erzeugen (gleiches Format wie tools/schluessel.html).
export async function makeKeys(passwords, iterations = 600000) {
  const pair = await subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt']);
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  const wraps = [];
  for (const pw of passwords) wraps.push(await wrapPrivate(pkcs8, pw, iterations));
  return { v: 1, created: new Date().toISOString().slice(0, 10), publicKey: b64(await subtle.exportKey('spki', pair.publicKey)), wraps };
}

async function wrapPrivate(pkcs8, password, iterations) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  const k = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const data = await subtle.encrypt({ name: 'AES-GCM', iv }, k, pkcs8);
  return { id: b64(crypto.getRandomValues(new Uint8Array(6))), iterations, salt: b64(salt), iv: b64(iv), data: b64(data) };
}
