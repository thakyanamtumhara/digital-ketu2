export function usdToInrRate(settings) {
  const rate = settings?.usdToInr
  return Number.isFinite(rate) && rate > 0 ? rate : 88
}
