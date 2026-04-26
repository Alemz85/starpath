import { create } from 'zustand'
import { ipc } from '@/lib/ipc'
import { parseScoreHistory } from '@/lib/parsers/tsv'
import { parseScouting, parseApplications, parsePipeline, parseReportPath } from '@/lib/parsers/markdown'
import type { ScoreEntry, ScoutingEntry, ApplicationEntry, PipelineUrl, ReportFile } from '@/types'

interface DataState {
  scoreHistory:   ScoreEntry[]
  scouting:       ScoutingEntry[]
  applications:   ApplicationEntry[]
  pipeline:       PipelineUrl[]
  reports:        ReportFile[]
  loaded:         boolean
  loading:        boolean

  load:    () => Promise<void>
  refresh: () => Promise<void>
}

export const useDataStore = create<DataState>((set) => ({
  scoreHistory: [],
  scouting:     [],
  applications: [],
  pipeline:     [],
  reports:      [],
  loaded:       false,
  loading:      false,

  load: async () => {
    const state = useDataStore.getState()
    if (state.loaded || state.loading) return
    set({ loading: true })
    await loadAll()
    set({ loading: false, loaded: true })
  },

  refresh: async () => {
    set({ loading: true })
    await loadAll()
    set({ loading: false })
  },
}))

async function loadAll() {
  const [
    scoreTsv,
    scoutingMd,
    appsMd,
    pipelineMd,
    reportPaths,
  ] = await Promise.all([
    ipc.readFile('data/score-history.tsv'),
    ipc.readFile('data/scouting.md'),
    ipc.readFile('data/applications.md'),
    ipc.readFile('data/pipeline.md'),
    ipc.listRecursive('reports', '.md'),
  ])

  const scoreHistory   = scoreTsv    ? parseScoreHistory(scoreTsv) : []
  const scouting       = scoutingMd  ? parseScouting(scoutingMd)   : []
  const applications   = appsMd      ? parseApplications(appsMd)   : []
  const pipeline       = pipelineMd  ? parsePipeline(pipelineMd)   : []
  const reports        = (reportPaths ?? []).flatMap(p => {
    const r = parseReportPath(p)
    return r ? [r] : []
  })

  useDataStore.setState({ scoreHistory, scouting, applications, pipeline, reports })
}
