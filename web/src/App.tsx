import { BrowserRouter, Routes, Route, Link, useLocation } from 'react-router-dom'
import { NoticeProvider } from './notice'
import { SenderProvider } from './sender'
import { Landing } from './pages/Landing'
import { Dashboard } from './pages/Dashboard'
import { SignerPage } from './pages/SignerPage'
import { SignersPage } from './pages/SignersPage'
import { VerifyPage } from './pages/VerifyPage'
import { EncryptionPage } from './pages/EncryptionPage'
import { DecryptionPage } from './pages/DecryptionPage'

function Header() {
  const { pathname } = useLocation()
  const signing =
    pathname === '/signing' ||
    pathname === '/signers' ||
    pathname === '/verify' ||
    pathname.startsWith('/sign/')
  const encrypting = pathname === '/encryption' || pathname === '/decryption'
  return (
    <header>
      <div className="bar">
        <a className="brand" href="/">
          <img className="brand-logo" src="/tasra-logo.png" alt="" />
          <span className="brand-name">Tasra Demo</span>
          <span className="label">LOCAL DEMO</span>
        </a>
        {signing ? (
          <nav aria-label="Main">
            <Link to="/signing">Sign Document</Link>
            <Link to="/signers">Signatures</Link>
            <Link to="/verify">Verification</Link>
          </nav>
        ) : null}
        {encrypting ? (
          <nav aria-label="Encryption">
            <Link to="/encryption">Encryption</Link>
            <Link to="/decryption">Decryption</Link>
          </nav>
        ) : null}
      </div>
    </header>
  )
}

function routeClass(pathname: string): string {
  if (pathname === '/signing') return 'route-signing'
  if (pathname === '/signers') return 'route-signers'
  if (pathname === '/verify') return 'route-verify'
  if (pathname === '/encryption') return 'route-encryption'
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
        <Route path="/decryption" element={<DecryptionPage />} />
        <Route path="/signers" element={<SignersPage />} />
        <Route path="/verify" element={<VerifyPage />} />
        <Route path="/sign/:id/:slot" element={<SignerPage />} />
      </Routes>
    </main>
  )
}

function Layout() {
  return (
    <>
      <div className="watermark" aria-hidden="true" />
      <SenderProvider>
        <NoticeProvider>
          <Header />
          <Main />
          <footer>
            Built with Tasra SDK · Verified signatures and identity-scoped BLS encryption.
            <span className="label">v{import.meta.env.VITE_APP_VERSION}</span>
          </footer>
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
