import { Check, Laptop, Moon, Sun } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function ThemeSwitcher() {
  const { setTheme, theme } = useTheme()
  const currentTheme = theme ?? "system"

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button size="icon" variant="ghost" />}>
        <Sun className="size-4 dark:hidden" />
        <Moon className="hidden size-4 dark:block" />
        <span className="sr-only">Theme</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun />
          Light
          {currentTheme === "light" ? <Check className="ml-auto" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon />
          Dark
          {currentTheme === "dark" ? <Check className="ml-auto" /> : null}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Laptop />
          System
          {currentTheme === "system" ? <Check className="ml-auto" /> : null}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
