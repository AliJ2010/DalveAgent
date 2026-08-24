import { ElectronAPI } from '@electron-toolkit/preload'
import type { DalveApi } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    dalve: DalveApi
  }
}
