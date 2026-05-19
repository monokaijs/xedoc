export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) {
    throw new Error("Enter a server URL.")
  }

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
  const url = new URL(withProtocol)
  url.pathname = url.pathname.replace(/\/+$/, "")
  url.search = ""
  url.hash = ""
  return url.toString().replace(/\/+$/, "")
}
