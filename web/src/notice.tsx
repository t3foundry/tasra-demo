import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

const NoticeContext = createContext<(message: string) => void>(() => {})

export function useNotice() {
  return useContext(NoticeContext)
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const notify = useCallback((msg: string) => {
    setMessage(msg)
    setVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    hideTimer.current = setTimeout(() => {
      setVisible(false)
      clearTimer.current = setTimeout(() => setMessage(''), 600)
    }, 30000)
  }, [])

  useEffect(
    () => () => {
      if (hideTimer.current) clearTimeout(hideTimer.current)
      if (clearTimer.current) clearTimeout(clearTimer.current)
    },
    [],
  )

  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div
        id="notice"
        role="status"
        aria-live="polite"
        className={visible ? 'visible' : ''}
      >
        {message}
      </div>
    </NoticeContext.Provider>
  )
}