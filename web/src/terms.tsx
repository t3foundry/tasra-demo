import {
  useEffect,
  useState,
  type ReactNode,
} from 'react'
import { Link } from 'react-router-dom'

const TERMS_STORAGE_KEY = 'tasra:terms-accepted'

export function hasAcceptedTerms(): boolean {
  try {
    return localStorage.getItem(TERMS_STORAGE_KEY) === 'accepted'
  } catch {
    return false
  }
}

function acceptTerms() {
  try {
    localStorage.setItem(TERMS_STORAGE_KEY, 'accepted')
  } catch {
    // storage unavailable; the overlay will simply reappear on reload
  }
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**')) {
      return <strong key={i}>{part.slice(2, -2)}</strong>
    }
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return <em key={i}>{part.slice(1, -1)}</em>
    }
    return part
  })
}

function renderMarkdown(md: string): ReactNode[] {
  const lines = md.split(/\r?\n/)
  const out: ReactNode[] = []
  let list: string[] = []
  let key = 0

  const flushList = () => {
    if (list.length === 0) return
    const items = list
    out.push(
      <ul key={`ul-${key++}`}>
        {items.map((item, i) => (
          <li key={i}>{inline(item)}</li>
        ))}
      </ul>,
    )
    list = []
  }

  for (const raw of lines) {
    const trimmed = raw.trim()
    if (!trimmed) {
      flushList()
      continue
    }
    if (trimmed === '---') {
      flushList()
      out.push(<hr key={`hr-${key++}`} />)
      continue
    }
    if (trimmed.startsWith('## ')) {
      flushList()
      out.push(<h2 key={`h2-${key++}`}>{inline(trimmed.slice(3))}</h2>)
      continue
    }
    if (trimmed.startsWith('# ')) {
      flushList()
      out.push(<h1 key={`h1-${key++}`}>{inline(trimmed.slice(2))}</h1>)
      continue
    }
    if (trimmed.startsWith('* ')) {
      list.push(trimmed.slice(2))
      continue
    }
    if (trimmed.startsWith('> ')) {
      flushList()
      out.push(
        <blockquote key={`bq-${key++}`}>
          <p>{inline(trimmed.slice(2))}</p>
        </blockquote>,
      )
      continue
    }
    flushList()
    out.push(<p key={`p-${key++}`}>{inline(trimmed)}</p>)
  }
  flushList()
  return out
}

export function TermsOverlay() {
  const [accepted, setAccepted] = useState(hasAcceptedTerms)

  if (accepted) return null

  const agree = () => {
    acceptTerms()
    setAccepted(true)
  }

  return (
    <div
      className="terms-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="terms-overlay-title"
    >
      <div className="terms-modal">
        <h2 id="terms-overlay-title">Terms &amp; Conditions</h2>
        <p>
          Please read the full Terms and Conditions before using the Tasra demo
          application.
        </p>
        <p>
          <Link to="/terms" target="_blank" rel="noopener noreferrer">
            Read the Terms and Conditions
          </Link>
        </p>
        <p className="terms-cookie-note">This site does not use any cookies.</p>
        <button type="button" className="primary" onClick={agree}>
          Agree to T&amp;C
        </button>
      </div>
    </div>
  )
}

export function TermsPage() {
  const [content, setContent] = useState<string>('')
  const [error, setError] = useState(false)

  useEffect(() => {
    let active = true
    fetch('/terms-and-conditions.md')
      .then((res) => {
        if (!res.ok) throw new Error(res.statusText)
        return res.text()
      })
      .then((text) => {
        if (active) setContent(text)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [])

  return (
    <div className="terms-doc">
      <p>
        <Link className="back" to="/">
          ← Back to application
        </Link>
      </p>
      {error ? (
        <p className="error">
          The Terms and Conditions could not be loaded. Please try again.
        </p>
      ) : content ? (
        renderMarkdown(content)
      ) : (
        <p className="muted">Loading…</p>
      )}
    </div>
  )
}