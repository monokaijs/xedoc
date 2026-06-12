import { useCallback, useEffect, useState } from "react"

export type AgentSoundType = "done" | "question"

const AGENT_SOUNDS_STORAGE_KEY = "xedoc.agent-sounds.enabled"
const AGENT_SOUND_PREFERENCE_EVENT = "xedoc:agent-sound-preference"
const DEFAULT_AGENT_SOUNDS_ENABLED = true
const AGENT_SOUND_SOURCES: Record<AgentSoundType, string> = {
  done: "/sounds/agent-done.ogg",
  question: "/sounds/agent-question.ogg",
}

export function useAgentSoundsPreference(): [boolean, (enabled: boolean) => void] {
  const [enabled, setEnabledState] = useState(DEFAULT_AGENT_SOUNDS_ENABLED)

  useEffect(() => {
    setEnabledState(readAgentSoundsEnabled())

    const handlePreferenceChange = () => {
      setEnabledState(readAgentSoundsEnabled())
    }
    window.addEventListener(AGENT_SOUND_PREFERENCE_EVENT, handlePreferenceChange)
    window.addEventListener("storage", handlePreferenceChange)
    return () => {
      window.removeEventListener(
        AGENT_SOUND_PREFERENCE_EVENT,
        handlePreferenceChange,
      )
      window.removeEventListener("storage", handlePreferenceChange)
    }
  }, [])

  const setEnabled = useCallback((nextEnabled: boolean) => {
    setAgentSoundsEnabled(nextEnabled)
    setEnabledState(nextEnabled)
  }, [])

  return [enabled, setEnabled]
}

export function playAgentSound(type: AgentSoundType): void {
  if (!readAgentSoundsEnabled() || typeof Audio === "undefined") {
    return
  }
  const audio = new Audio(AGENT_SOUND_SOURCES[type])
  audio.volume = 0.55
  void audio.play().catch(() => undefined)
}

function readAgentSoundsEnabled(): boolean {
  if (typeof window === "undefined") {
    return DEFAULT_AGENT_SOUNDS_ENABLED
  }
  const stored = window.localStorage.getItem(AGENT_SOUNDS_STORAGE_KEY)
  if (stored === null) {
    return DEFAULT_AGENT_SOUNDS_ENABLED
  }
  return stored === "true"
}

function setAgentSoundsEnabled(enabled: boolean): void {
  if (typeof window === "undefined") {
    return
  }
  window.localStorage.setItem(AGENT_SOUNDS_STORAGE_KEY, String(enabled))
  window.dispatchEvent(new Event(AGENT_SOUND_PREFERENCE_EVENT))
}
