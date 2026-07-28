// Celulares brasileiros ganharam o 9º dígito entre 2012-2016 e algumas origens
// (como o MSN Talk) ainda mandam o número no formato antigo de 8 dígitos.
// Geramos as duas variantes possíveis pra não depender de qual lado (MSN Talk
// ou o cadastro no Bitrix) está desatualizado.
export function phoneVariants(phone) {
  const digits = String(phone).replace(/\D/g, '');
  const variants = new Set([digits]);

  const match = digits.match(/^55(\d{2})(\d{8,9})$/);
  if (match) {
    const [, ddd, local] = match;
    if (local.length === 8 && /^[6-9]/.test(local)) {
      variants.add(`55${ddd}9${local}`);
    } else if (local.length === 9 && local[0] === '9') {
      variants.add(`55${ddd}${local.slice(1)}`);
    }
  }

  return [...variants];
}
