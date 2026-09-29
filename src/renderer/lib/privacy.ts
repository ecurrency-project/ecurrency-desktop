import type { PrivacyApi } from '../../shared/privacy'
import { unwrapBridge } from './bridge'

export const privacy = unwrapBridge<PrivacyApi>(window.privacy)
