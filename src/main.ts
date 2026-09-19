import { initializeBackendContext } from '@/services/backend-context'

void initializeBackendContext()
  .catch((error) => console.error('Backend initialization failed', error))
  .then(() => import('./bootstrap'))
