import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import go from "highlight.js/lib/languages/go"
import json from "highlight.js/lib/languages/json"
import javascript from "highlight.js/lib/languages/javascript"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import shell from "highlight.js/lib/languages/shell"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"

hljs.registerLanguage("bash", bash)
hljs.registerLanguage("css", css)
hljs.registerLanguage("go", go)
hljs.registerLanguage("html", xml)
hljs.registerLanguage("javascript", javascript)
hljs.registerLanguage("json", json)
hljs.registerLanguage("markdown", markdown)
hljs.registerLanguage("python", python)
hljs.registerLanguage("rust", rust)
hljs.registerLanguage("sh", shell)
hljs.registerLanguage("sql", sql)
hljs.registerLanguage("tsx", typescript)
hljs.registerLanguage("typescript", typescript)
hljs.registerLanguage("xml", xml)
hljs.registerLanguage("yaml", yaml)

export function highlightCode(content: string, language?: string | null): string {
  if (language && hljs.getLanguage(language)) {
    return hljs.highlight(content, { language }).value
  }
  return hljs.highlightAuto(content).value
}
