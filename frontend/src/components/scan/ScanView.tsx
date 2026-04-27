'use client'

import { useEffect } from 'react'
import { useAppStore } from '@/store/app'
import { useDataStore } from '@/store/data'
import { useSpawnsStore } from '@/store/spawns'
import { ActionButton, ActivityPanel, pickVisible } from '@/components/command-center/CommandCenter'
import { Play, Zap, FileOutput, Radar } from 'lucide-react'

const FULL_SCAN_ID = 'cmd-full-scan'
const API_SCAN_ID  = 'cmd-api-scan'
const PIPELINE_ID  = 'cmd-pipeline'

export function ScanView() {
  const { repoPath } = useAppStore()
  const { refresh } = useDataStore()
  const { spawns, start, kill, clear } = useSpawnsStore()

  const fullScan = spawns[FULL_SCAN_ID]
  const apiScan  = spawns[API_SCAN_ID]
  const pipeline = spawns[PIPELINE_ID]

  const visible = pickVisible(fullScan, apiScan, pipeline)
  const anyRunning =
    fullScan?.status === 'running' ||
    apiScan?.status === 'running' ||
    pipeline?.status === 'running'

  // Refresh data store whenever any spawn finishes.
  useEffect(() => {
    if (fullScan?.status === 'done' || fullScan?.status === 'error' || fullScan?.status === 'killed') refresh()
  }, [fullScan?.status, refresh])
  useEffect(() => {
    if (apiScan?.status === 'done' || apiScan?.status === 'error' || apiScan?.status === 'killed') refresh()
  }, [apiScan?.status, refresh])
  useEffect(() => {
    if (pipeline?.status === 'done' || pipeline?.status === 'error' || pipeline?.status === 'killed') refresh()
  }, [pipeline?.status, refresh])

  const handleFullScan = () => {
    if (fullScan?.status === 'running') { kill(FULL_SCAN_ID); return }
    if (fullScan) clear(FULL_SCAN_ID)
    start(FULL_SCAN_ID, 'Full Scan', 'claude', ['-p', '@modes/scan.md'])
  }
  const handleApiScan = () => {
    if (apiScan?.status === 'running') { kill(API_SCAN_ID); return }
    if (apiScan) clear(API_SCAN_ID)
    start(API_SCAN_ID, 'API Scan', 'node', ['scripts/scan.mjs'])
  }
  const handlePipeline = () => {
    if (pipeline?.status === 'running') { kill(PIPELINE_ID); return }
    if (pipeline) clear(PIPELINE_ID)
    start(PIPELINE_ID, 'Generate Reports', 'claude', ['-p', '@modes/pipeline.md'])
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="title-bar gap-3 px-4 border-b border-border-default bg-bg-chrome">
        <h1 className="text-body text-text-1 font-medium flex items-center gap-2">
          <Radar size={14} className="text-accent" />
          Scan
        </h1>
        {anyRunning && (
          <span className="text-micro font-mono px-2 py-0.5 rounded-pill border text-accent border-accent/40 bg-accent/10">
            running
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col px-8 pt-8 pb-8 gap-7 overflow-hidden min-h-0">
        {/* Centered button row */}
        <div className="shrink-0 flex items-center justify-center gap-3 pt-2">
          <ActionButton
            label="Full Scan"
            icon={Play}
            tone="primary"
            running={fullScan?.status === 'running'}
            onClick={handleFullScan}
            disabled={!repoPath}
            title="Playwright + ATS APIs + WebSearch — uses Claude (token cost)"
          />
          <ActionButton
            label="API Only"
            icon={Zap}
            tone="outline"
            running={apiScan?.status === 'running'}
            onClick={handleApiScan}
            disabled={!repoPath}
            title="Direct ATS API calls — zero token cost, instant"
          />
          <div className="w-px h-6 bg-border-default" aria-hidden />
          <ActionButton
            label="Generate Reports"
            icon={FileOutput}
            tone="outline"
            running={pipeline?.status === 'running'}
            onClick={handlePipeline}
            disabled={!repoPath}
            title="Process pending listings in data/pipeline.md into evaluation reports"
          />
        </div>

        {/* Activity panel — fills remaining height */}
        <ActivityPanel record={visible} />
      </div>
    </div>
  )
}
