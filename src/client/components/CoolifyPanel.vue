<script setup lang="ts">
import { computed } from "vue";
import type { CoolifyResourceSummary } from "../../types";
import { relativeTime } from "../../types";
import { useCoolify } from "../composables/useCoolify";

const coolify = useCoolify();

const resources = computed(() => coolify.snapshot.value?.resources ?? []);
const healthyCount = computed(
  () =>
    resources.value.filter((resource) =>
      /^(running|healthy|running:healthy)$/i.test(resource.status),
    ).length,
);
const intentionallyStoppedCount = computed(
  () =>
    resources.value.filter(
      (resource) =>
        /^RETIRED\b/i.test(resource.name) &&
        /exited|stopped/i.test(resource.status),
    ).length,
);
const attentionCount = computed(
  () =>
    resources.value.length -
    healthyCount.value -
    intentionallyStoppedCount.value,
);

function statusClass(resource: CoolifyResourceSummary): string {
  if (resource.activeDeployment) return "coolify-status-pending";
  if (/^(running|healthy|running:healthy)$/i.test(resource.status)) {
    return "coolify-status-success";
  }
  if (/exited|failed|unhealthy|stopped/i.test(resource.status)) {
    return "coolify-status-failure";
  }
  return "coolify-status-neutral";
}

function deploymentLabel(resource: CoolifyResourceSummary): string {
  const deployment = resource.activeDeployment ?? resource.latestDeployment;
  if (!deployment) return "No deployment history";
  const timestamp = deployment.finishedAt ?? deployment.startedAt;
  return `${deployment.status}${timestamp ? ` · ${relativeTime(timestamp)}` : ""}`;
}

function versionValue(resource: CoolifyResourceSummary): string | null {
  return resource.imageTag ?? resource.repository;
}

function versionLabel(resource: CoolifyResourceSummary): string {
  const value = versionValue(resource);
  if (!value) return "—";
  return /^[a-f0-9]{40,64}$/i.test(value) ? value.slice(0, 12) : value;
}
</script>

<template>
  <section class="coolify-panel" aria-labelledby="coolify-heading">
    <div class="coolify-panel-header">
      <div>
        <h2 id="coolify-heading">Coolify deployments</h2>
        <p v-if="coolify.snapshot.value" class="coolify-summary">
          {{ healthyCount }} healthy · {{ intentionallyStoppedCount }} retired ·
          {{ attentionCount }} needs attention · updated
          {{ relativeTime(coolify.snapshot.value.generatedAt) }}
        </p>
        <p v-else class="coolify-summary">Hosted Coolify resource state</p>
      </div>
      <button
        type="button"
        class="btn-refresh-all"
        :disabled="coolify.loading.value"
        @click="coolify.refresh"
      >
        Reload snapshot
      </button>
    </div>

    <div
      v-if="coolify.stale.value && coolify.snapshot.value"
      class="coolify-warning"
    >
      Showing the last successful Coolify snapshot.
      {{ coolify.snapshot.value.error ?? "The snapshot is stale." }}
    </div>
    <div v-else-if="coolify.requestError.value" class="coolify-warning">
      {{ coolify.requestError.value }}
    </div>

    <div v-if="resources.length" class="coolify-table-wrap">
      <table class="coolify-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Project / environment</th>
            <th>Status</th>
            <th>Version</th>
            <th>Latest deployment</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="resource in resources" :key="resource.uuid">
            <td>
              <a :href="resource.dashboardUrl" target="_blank" rel="noopener">
                {{ resource.name }}
              </a>
              <span class="coolify-resource-meta">
                {{ resource.type }}
                <span v-if="!resource.registered" class="coolify-unregistered">
                  unregistered
                </span>
              </span>
            </td>
            <td>
              {{ resource.project }}
              <span class="coolify-resource-meta">{{
                resource.environment
              }}</span>
            </td>
            <td>
              <span class="coolify-status" :class="statusClass(resource)">
                {{ resource.activeDeployment ? "deploying" : resource.status }}
              </span>
            </td>
            <td>
              <code :title="versionValue(resource) ?? undefined">{{
                versionLabel(resource)
              }}</code>
            </td>
            <td>{{ deploymentLabel(resource) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="coolify.loading.value" class="coolify-empty">
      Loading Coolify state…
    </p>
    <p v-else class="coolify-empty">No Coolify resources are available.</p>
  </section>
</template>
