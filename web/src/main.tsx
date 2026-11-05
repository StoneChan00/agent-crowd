import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// iOS Safari: the soft keyboard shrinks the visual viewport but leaves
// 100dvh untouched (interactive-widget=resizes-content only resizes in
// Chromium), so the composer would end up behind the keyboard. Mirror
// visualViewport.height into --app-h (consumed by .app in styles.css) and
// re-pin the shell if iOS scrolled the layout viewport to reveal the caret.
// Elsewhere this listener is idle and the dvh fallback keeps ruling.
const visualViewport = window.visualViewport
if (visualViewport) {
  const syncAppHeight = () => {
    document.documentElement.style.setProperty('--app-h', `${Math.round(visualViewport.height)}px`)
    if (window.scrollY !== 0) window.scrollTo(0, 0)
  }
  visualViewport.addEventListener('resize', syncAppHeight)
  syncAppHeight()
}

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(<App />)
