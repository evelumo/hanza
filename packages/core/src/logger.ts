export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export function createLogger(scope: string): Logger {
  const write = (level: 'info' | 'error', message: string, fields?: Record<string, unknown>) => {
    const line = JSON.stringify({ time: new Date().toISOString(), level, scope, message, ...fields })
    if (level === 'error') console.error(line)
    else console.log(line)
  }
  return {
    info: (message, fields) => write('info', message, fields),
    error: (message, fields) => write('error', message, fields),
  }
}
