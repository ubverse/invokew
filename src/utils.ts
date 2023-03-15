import { IHash, LegalHttpHash } from 'types'

export const toStringHash = (h: Partial<LegalHttpHash>): IHash<string> =>
  Object.fromEntries(
    Object.entries(h)
      .map(([key, value]) => [key, (value ?? '').toString()])
      .filter(([, value]) => value.length > 0)
  )
