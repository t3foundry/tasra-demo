import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { NoticeProvider } from './notice'
import { SenderProvider } from './sender'
import { Landing } from './pages/Landing'
import { Dashboard } from './pages/Dashboard'
import { SignerPage } from './pages/SignerPage'
import { SignersPage } from './pages/SignersPage'
import { KeysPage } from './pages/KeysPage'
import { VerifyPage } from './pages/VerifyPage'
import { EncryptionPage } from './pages/EncryptionPage'
import { DecryptionPage } from './pages/DecryptionPage'
import { TermsOverlay, TermsPage } from './terms'

function Header() {
  const { pathname } = useLocation()
  const signing =
    pathname === '/signing' ||
    pathname === '/signers' ||
    pathname === '/verify' ||
    pathname.startsWith('/sign/')
  const encrypting =
    pathname === '/encryption' ||
    pathname === '/keys' ||
    pathname === '/decryption'
  const isActive = (to: string) =>
    to === '/signing'
      ? pathname === '/signing' || pathname.startsWith('/sign/')
      : pathname === to
  return (
    <header>
      <div className="bar">
        <a className="brand" href="/">
          <img className="brand-logo" src="/tasra-logo.png" alt="" />
          <span className="brand-name">Tasra Network Demo</span>
        </a>
        {signing ? (
          <nav aria-label="Main">
            <Link className={isActive('/signing') ? 'active' : ''} to="/signing">
              Sign Document
            </Link>
            <Link className={isActive('/signers') ? 'active' : ''} to="/signers">
              Signing Keys
            </Link>
            <Link className={isActive('/verify') ? 'active' : ''} to="/verify">
              Verification
            </Link>
          </nav>
        ) : null}
        {encrypting ? (
          <nav aria-label="Encryption">
            <Link className={isActive('/encryption') ? 'active' : ''} to="/encryption">
              Encryption
            </Link>
            <Link className={isActive('/keys') ? 'active' : ''} to="/keys">
              Keys
            </Link>
            <Link className={isActive('/decryption') ? 'active' : ''} to="/decryption">
              Decryption
            </Link>
          </nav>
        ) : null}
        <nav className="bar-links" aria-label="External">
          <a
            href="https://docs.tasra.network"
            target="_blank"
            rel="noopener noreferrer"
          >
            Documentation
          </a>
          <a
            href="https://github.com/t3foundry"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
          <a
            href="https://t.me/+eTA2Uz0TbSA2ZTI0"
            target="_blank"
            rel="noopener noreferrer"
          >
            Telegram
          </a>
        </nav>
      </div>
    </header>
  )
}

function routeClass(pathname: string): string {
  if (pathname === '/signing') return 'route-signing'
  if (pathname === '/signers') return 'route-signers'
  if (pathname === '/verify') return 'route-verify'
  if (pathname === '/encryption') return 'route-encryption'
  if (pathname === '/keys') return 'route-encryption'
  if (pathname === '/decryption') return 'route-decryption'
  if (pathname.startsWith('/sign/')) return 'route-signer'
  return ''
}

function Main() {
  const { pathname } = useLocation()
  return (
    <main className={routeClass(pathname)}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/signing" element={<Dashboard />} />
        <Route path="/encryption" element={<EncryptionPage />} />
        <Route path="/keys" element={<KeysPage />} />
        <Route path="/decryption" element={<DecryptionPage />} />
        <Route path="/signers" element={<SignersPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/sign/:id/:slot" element={<SignerPage />} />
        <Route path="/terms" element={<TermsPage />} />
      </Routes>
    </main>
  )
}

function Layout() {
  const { pathname } = useLocation()
  const isTerms = pathname === '/terms'
  return (
    <>
      <div className="watermark" aria-hidden="true" />
      <SenderProvider>
        <NoticeProvider>
          <Header />
          <Main />
          <footer>
            <span className="footer-note">
              Built with Tasra SDK · Verified signatures and identity-scoped
              BLS encryption.
              <span className="label">v{import.meta.env.VITE_APP_VERSION}</span>
            </span>
            <a
              className="footer-link"
              href="https://t3foundry.com/en/privacy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Privacy Policy
            </a>
          </footer>
          {!isTerms ? <TermsOverlay /> : null}
        </NoticeProvider>
      </SenderProvider>
    </>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  )
}
