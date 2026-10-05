import { BrowserRouter, Routes, Route, Link } from 'react-router-dom'
import { NoticeProvider } from './notice'
import { SenderProvider } from './sender'
import { Dashboard } from './pages/Dashboard'
import { SignerPage } from './pages/SignerPage'
import { VerifyPage } from './pages/VerifyPage'

export default function App() {
  return (
    <BrowserRouter>
      <SenderProvider>
        <NoticeProvider>
          <header>
          <div className="bar">
            <a className="brand" href="/">
              Tasra Sign <span className="label">LOCAL DEMO</span>
            </a>
            <nav aria-label="Main">
              <Link to="/">Documents</Link>
              <Link to="/verify">Verify</Link>
            </nav>
          </div>
        </header>
        <main>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/verify" element={<VerifyPage />} />
            <Route path="/sign/:id/:person" element={<SignerPage />} />
          </Routes>
        </main>
        <footer>
          Built with Tasra SDK · Two people. Two independently verified signatures.
        </footer>
        </NoticeProvider>
      </SenderProvider>
    </BrowserRouter>
  )
}