import { useState, useEffect } from 'react'
import { IDE } from './components/IDE'

export default function App() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')

  useEffect(() => {
    const saved = localStorage.getItem('vsc-ide-theme')
    if (saved === 'light') setTheme('light')
  }, [])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    localStorage.setItem('vsc-ide-theme', next)
  }

  return (
    <div className={`shell${theme === 'light' ? ' light' : ''}`}>
      <IDE theme={theme} onToggleTheme={toggleTheme} />
    </div>
  )
}
