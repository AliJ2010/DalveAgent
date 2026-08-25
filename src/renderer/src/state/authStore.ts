import { create } from 'zustand'

type AuthStatus = 'loading' | 'signedOut' | 'signedIn' | 'unconfigured'

interface AuthStoreState {
  status: AuthStatus
  email: string | null
  init: () => Promise<void>
  signUp: (email: string, password: string) => Promise<string | undefined>
  signIn: (email: string, password: string) => Promise<string | undefined>
  signOut: () => Promise<void>
}

export const useAuthStore = create<AuthStoreState>((set) => ({
  status: 'loading',
  email: null,

  init: async () => {
    const configured = await window.dalve.cloud.isConfigured()
    if (!configured) {
      set({ status: 'unconfigured' })
      return
    }
    const session = await window.dalve.cloud.getSession()
    set(session.signedIn ? { status: 'signedIn', email: session.email ?? null } : { status: 'signedOut' })
  },

  signUp: async (email, password) => {
    const { error } = await window.dalve.cloud.signUp(email, password)
    if (error) return error
    set({ status: 'signedIn', email })
    return undefined
  },

  signIn: async (email, password) => {
    const { error } = await window.dalve.cloud.signIn(email, password)
    if (error) return error
    set({ status: 'signedIn', email })
    return undefined
  },

  signOut: async () => {
    await window.dalve.cloud.signOut()
    set({ status: 'signedOut', email: null })
  }
}))
