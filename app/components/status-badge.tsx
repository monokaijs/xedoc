import type { AccountStatus, ChatStatus, MessageStatus } from "@/types"
import { Badge } from "@/components/ui/badge"

type Status = AccountStatus | ChatStatus | MessageStatus | "OFFLINE" | "ONLINE"
type BadgeVariant = "default" | "secondary" | "destructive" | "outline"

export function StatusBadge({
  className,
  status,
}: {
  className?: string
  status: Status
}) {
  return (
    <Badge className={className} variant={statusBadgeVariant(status)}>
      {status.toLowerCase()}
    </Badge>
  )
}

function statusBadgeVariant(status: Status): BadgeVariant {
  switch (status) {
    case "ERROR":
    case "FAILED":
    case "OFFLINE":
      return "destructive"
    case "CONNECTED":
    case "COMPLETED":
    case "ONLINE":
      return "default"
    case "AUTHENTICATING":
    case "PENDING":
    case "RUNNING":
    case "STREAMING":
      return "secondary"
    case "ARCHIVED":
    case "DISCONNECTED":
    case "IDLE":
    default:
      return "outline"
  }
}
