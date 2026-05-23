import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { useState } from "react"
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DEFAULT_DOCUMENT_TITLE } from "@/lib/document-title"
import { SessionProvider } from "@/providers/session-provider"
import "./index.css"

export function meta() {
  return [{ title: DEFAULT_DOCUMENT_TITLE }]
}

export function links() {
  return [{ rel: "icon", href: "/favicon.svg", type: "image/svg+xml" }]
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function Root() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  )

  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <SessionProvider>
            <Outlet />
          </SessionProvider>
          <Toaster richColors />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unexpected application error."

  return (
    <main className="flex min-h-svh items-center justify-center bg-background p-6">
      <section className="max-w-md rounded-xl border bg-background p-5 shadow-sm">
        <h1 className="text-lg font-semibold">xedoc</h1>
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {message}
        </p>
      </section>
    </main>
  )
}
