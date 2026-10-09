import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation } from 'react-router-dom'

type NoticeKind = 'info' | 'success' | 'error'

const NoticeContext = createContext<(message: string, kind?: NoticeKind) => void>(
  () => {},
)

export function useNotice() {
  return useContext(NoticeContext)
}

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('')
  const [kind, setKind] = useState<NoticeKind>('info')
  const [visible, setVisible] = useState(false)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const clearTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const location = useLocation()

  const dismiss = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    setVisible(false)
    setMessage('')
  }, [])

  const notify = useCallback((msg: string, nextKind: NoticeKind = 'info') => {
    setMessage(msg)
    setKind(nextKind)
    setVisible(true)
    if (hideTimer.current) clearTimeout(hideTimer.current)
    if (clearTimer.current) clearTimeout(clearTimer.current)
    hideTimer.current = setTimeout(() => {
      setVisible(false)
      clearTimer.current = setTimeout(() => setMessage(''), 600)
    }, 30000)
  }, [])

  useEffect(() => {
    dismiss()
  }, [location.pathname, dismiss])

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
        data-kind={kind}
      >
        {message}
      </div>
    </NoticeContext.Provider>
  )
}