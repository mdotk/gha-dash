import { computed, onMounted, onUnmounted, ref } from "vue";
import type { CoolifySnapshot } from "../../types";

const POLL_INTERVAL_MS = 30_000;

export function useCoolify() {
  const snapshot = ref<CoolifySnapshot | null>(null);
  const loading = ref(true);
  const requestError = ref<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  const stale = computed(() => {
    if (!snapshot.value) return true;
    const age = Date.now() - Date.parse(snapshot.value.generatedAt);
    return (
      age > snapshot.value.staleAfterSeconds * 1000 ||
      snapshot.value.error !== null
    );
  });

  async function refresh() {
    try {
      const response = await fetch("/api/coolify", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(
          body.error ?? `Coolify state request failed (${response.status})`,
        );
      }
      snapshot.value = body as CoolifySnapshot;
      requestError.value = null;
    } catch (error) {
      requestError.value =
        error instanceof Error ? error.message : "Coolify state request failed";
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    void refresh();
    timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
  });
  onUnmounted(() => timer && clearInterval(timer));

  return { snapshot, loading, requestError, stale, refresh };
}
