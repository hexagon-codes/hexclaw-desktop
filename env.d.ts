/// <reference types="vite/client" />

interface NaiveMessage {
  success: (msg: string) => void
  error: (msg: string) => void
  info: (msg: string) => void
  warning: (msg: string) => void
}

interface Window {
  $message?: NaiveMessage
}
