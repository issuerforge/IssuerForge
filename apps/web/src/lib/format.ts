export const fmt = (n: number, decimals = 2): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

export const amount = (n: number, unit: string, decimals = 2): string =>
  `${fmt(n, decimals)} ${unit}`

export const parseAmount = (raw: string): number => {
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const value = Number.parseFloat(cleaned)
  return Number.isFinite(value) ? value : 0
}

export const truncate = (address: string, head = 6, tail = 4): string =>
  `${address.slice(0, head)}…${address.slice(-tail)}`
