import { createCn } from 'cn/config'
import type { CnFunction } from 'cn'

export const cn: CnFunction = createCn({ extend: { classGroups: { 'font-size': [{ text: ['readout', 'compact', 'micro', 'badge', 'emoji', 'code-inline'] }] } } })
