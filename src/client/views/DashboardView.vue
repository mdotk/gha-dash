<script setup lang="ts">
import { inject } from "vue";
import CoolifyPanel from "../components/CoolifyPanel.vue";
import ErrorBanner from "../components/ErrorBanner.vue";
import WorkflowTable from "../components/WorkflowTable.vue";
import type { useWorkflows } from "../composables/useWorkflows";

const workflows = inject<ReturnType<typeof useWorkflows>>("workflows")!;
</script>

<template>
  <div class="dashboard">
    <ErrorBanner :errors="workflows.errors.value" />
    <CoolifyPanel />
    <WorkflowTable
      :groups="workflows.groups.value"
      :refreshing-repo="workflows.refreshingRepo.value"
      @refresh-repo="workflows.refreshRepo"
    />
  </div>
</template>
