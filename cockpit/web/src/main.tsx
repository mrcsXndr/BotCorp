import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './app.css';
import { router } from './routes';
import { MotionRoot, ToastRegion } from './ui';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 2000 } } });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <MotionRoot>
        <RouterProvider router={router} />
        <ToastRegion />
      </MotionRoot>
    </QueryClientProvider>
  </StrictMode>,
);
