import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

const NoticeContext = createContext<(message: string) => void>(() => {})

export function useNotice() {
  return useContext(NoticeContext)
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  const notify = useCallback((msg: string) => setMessage(msg), [])
  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div id="notice" role="status" aria-live="polite">
        {message}
      </div>
    </NoticeContext.Provider>
  )
}