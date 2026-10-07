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
          Tasra Sign <span className="label">LOCAL DEMO</span>
        </a>
        {signing ? (
          <nav aria-label="Main">
            <Link to="/signing">Documents</Link>
            <Link to="/signers">Signers</Link>
            <Link to="/verify">Verify</Link>
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

export default function App() {
  return (
    <BrowserRouter>
      <SenderProvider>
        <NoticeProvider>
          <Header />
          <main>
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
          <footer>
            Built with Tasra SDK · Verified signatures and identity-scoped BLS encryption.
            <span className="label">v{import.meta.env.VITE_APP_VERSION}</span>
          </footer>
        </NoticeProvider>
      </SenderProvider>
    </BrowserRouter>
  )
}