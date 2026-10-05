import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react'

const SenderContext = createContext<string>('')

export function useSender() {
  return useContext(SenderContext)
}

export function SenderProvider({ children }: { children: ReactNode }) {
  const [sender, setSender] = useState(() => sessionStorage.getItem('sender') ?? '')
  useEffect(() => {
    const hash = window.location.hash.slice(1)
    if (!hash) return
    const token = new URLSearchParams(hash).get('sender')
    if (token) {
      sessionStorage.setItem('sender', token)
      setSender(token)
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      )
    }
  }, [])
  return <SenderContext.Provider value={sender}>{children}</SenderContext.Provider>
}