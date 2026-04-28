'use client'

import { useState, useEffect } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'

interface ProfileForm {
  full_name: string
  email: string
  phone: string
  location: string
  linkedin: string
  comp_target: string
  comp_currency: string
}

export function StepProfile({ onComplete }: { onComplete: () => void }) {
  const [form, setForm] = useState<ProfileForm>({
    full_name: '', email: '', phone: '', location: '', linkedin: '',
    comp_target: '', comp_currency: 'EUR',
  })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Pre-fill from existing profile.yml if it exists
  useEffect(() => {
    ipc.readFile('user/profile.yml').then(raw => {
      if (!raw) return
      const extract = (key: string) => raw.match(new RegExp(`${key}:\\s*["']?([^"'\\n]+)["']?`))?.[1]?.trim()
      setForm(f => ({
        ...f,
        full_name: extract('full_name') ?? f.full_name,
        email:     extract('email')     ?? f.email,
        phone:     extract('phone')     ?? f.phone,
        location:  extract('location')  ?? f.location,
        linkedin:  extract('linkedin')  ?? f.linkedin,
      }))
    })
  }, [])

  const set = (key: keyof ProfileForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }))

  const canSave = form.full_name.trim() && form.email.trim()

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)

    let raw = await ipc.readFile('user/profile.yml')
    if (!raw || raw.trim().length < 20) {
      raw = `candidate:\n  full_name: ""\n  email: ""\n  phone: ""\n  location: ""\n  linkedin: ""\n\ncurrent_mode: scouting\n\ncomp:\n  target_range: ""\n  currency: "EUR"\n\ntargeting:\n  roles: []\n  seniority: "Mid"\n  remote: "preferred"\n`
    }

    const patch = (yaml: string, key: string, val: string) =>
      yaml.replace(new RegExp(`(  ${key}:\\s*)["']?[^"'\\n]*["']?`), `$1"${val}"`)

    let updated = raw
    updated = patch(updated, 'full_name', form.full_name)
    updated = patch(updated, 'email',     form.email)
    if (form.phone)    updated = patch(updated, 'phone',    form.phone)
    if (form.location) updated = patch(updated, 'location', form.location)
    if (form.linkedin) updated = patch(updated, 'linkedin', form.linkedin)
    if (form.comp_target) {
      updated = updated.replace(
        /(target_range:\s*)["']?[^"'\n]*["']?/,
        `$1"${form.comp_target}"`
      )
      updated = updated.replace(
        /(currency:\s*)["']?[^"'\n]*["']?/,
        `$1"${form.comp_currency}"`
      )
    }

    await ipc.writeFile('user/profile.yml', updated)
    setSaving(false)
    setSaved(true)
    setTimeout(onComplete, 600)
  }

  const Field = ({
    label, field, placeholder, type = 'text', required = false, hint,
  }: {
    label: string
    field: keyof ProfileForm
    placeholder: string
    type?: string
    required?: boolean
    hint?: string
  }) => (
    <div>
      <label className="flex items-baseline gap-1.5 mb-1.5">
        <span className="text-[12px] text-text-2 font-medium">{label}</span>
        {required && <span className="text-[10px] text-accent font-mono">required</span>}
        {hint && !required && <span className="text-[10.5px] text-text-4">· {hint}</span>}
      </label>
      <input
        type={type}
        value={form[field]}
        onChange={set(field)}
        placeholder={placeholder}
        className="w-full px-3 h-9 bg-bg-base border border-border-default focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 rounded-md text-[13px] text-text-1 placeholder:text-text-4 transition-all"
      />
    </div>
  )

  return (
    <div className="space-y-7">
      <div>
        <h2 className="text-[26px] font-semibold text-text-1 leading-tight mb-3">
          Tell us about you
        </h2>
        <p className="text-[14px] text-text-3 leading-relaxed">
          The basics used across evaluations, generated CVs, and outreach drafts.
          Only name and email are required to move on — the rest you can fill in
          later from Settings.
        </p>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-text-4 font-semibold mb-3">
          Identity
        </p>
        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Full name"    field="full_name"  placeholder="Jane Smith"        required />
          <Field label="Email"        field="email"      placeholder="you@email.com" type="email" required />
          <Field label="Phone"        field="phone"      placeholder="+1 xxx xxx xxxx"  hint="optional" />
          <Field label="Location"     field="location"   placeholder="City, Country"    hint="optional" />
          <div className="col-span-2">
            <Field label="LinkedIn URL" field="linkedin" placeholder="linkedin.com/in/yourname" hint="optional" />
          </div>
        </div>
      </div>

      <div>
        <p className="text-[10px] uppercase tracking-[0.12em] text-text-4 font-semibold mb-3">
          Compensation target
        </p>
        <div className="grid grid-cols-[1fr_120px] gap-3.5">
          <Field label="Target range" field="comp_target" placeholder="€45K–60K" hint="rough number is fine" />
          <div>
            <label className="flex items-baseline gap-1.5 mb-1.5">
              <span className="text-[12px] text-text-2 font-medium">Currency</span>
            </label>
            <input
              type="text"
              value={form.comp_currency}
              onChange={set('comp_currency')}
              placeholder="EUR"
              className="w-full px-3 h-9 bg-bg-base border border-border-default focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/15 rounded-md text-[13px] text-text-1 placeholder:text-text-4 transition-all"
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end pt-1">
        <button
          onClick={handleSave}
          disabled={!canSave || saving || saved}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-accent hover:bg-accent-hover disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98] text-white rounded-pill transition-all font-medium text-[14px] shadow-[0_2px_10px_rgba(124,92,255,0.25)]"
        >
          {saving && <Loader2 size={14} className="animate-spin" />}
          {saved && <CheckCircle2 size={15} />}
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  )
}
