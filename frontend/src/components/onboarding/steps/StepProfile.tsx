'use client'

import { useState, useEffect } from 'react'
import { CheckCircle2 } from 'lucide-react'
import { ipc } from '@/lib/ipc'

interface ProfileForm {
  full_name: string
  email: string
  phone: string
  location: string
  linkedin: string
  target_role_1: string
  target_role_2: string
  comp_target: string
  comp_currency: string
}

export function StepProfile({ onComplete }: { onComplete: () => void }) {
  const [form, setForm] = useState<ProfileForm>({
    full_name: '', email: '', phone: '', location: '', linkedin: '',
    target_role_1: '', target_role_2: '', comp_target: '', comp_currency: 'EUR',
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

    // Read existing profile.yml or scaffold a minimal one
    let raw = await ipc.readFile('user/profile.yml')
    if (!raw || raw.trim().length < 20) {
      raw = `candidate:\n  full_name: ""\n  email: ""\n  phone: ""\n  location: ""\n  linkedin: ""\n\ncurrent_mode: scouting\n\ncomp:\n  target_range: ""\n  currency: "EUR"\n\ntargeting:\n  roles: []\n  seniority: "Mid"\n  remote: "preferred"\n`
    }

    // Update candidate fields
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
    setTimeout(onComplete, 500)
  }

  const Field = ({ label, field, placeholder, type = 'text' }: {
    label: string; field: keyof ProfileForm; placeholder: string; type?: string
  }) => (
    <div>
      <label className="block text-label text-text-3 mb-1">{label}</label>
      <input
        type={type}
        value={form[field]}
        onChange={set(field)}
        placeholder={placeholder}
        className="w-full px-3 h-9 bg-bg-base border border-border-default focus:border-accent focus:outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
      />
    </div>
  )

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-section text-text-1 mb-2">Your profile</h2>
        <p className="text-body text-text-3">
          Basic info used across evaluations, CVs, and outreach. You can update this any time from Settings.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Full name *"    field="full_name"    placeholder="Alessandro Mezzanotte" />
        <Field label="Email *"        field="email"        placeholder="you@email.com" type="email" />
        <Field label="Phone"          field="phone"        placeholder="+39 xxx xxx xxxx" />
        <Field label="Location"       field="location"     placeholder="Barcelona, Spain" />
        <Field label="LinkedIn URL"   field="linkedin"     placeholder="linkedin.com/in/yourname" />
        <div /> {/* spacer */}
        <Field label="Comp target"    field="comp_target"  placeholder="€45K–60K" />
        <div>
          <label className="block text-label text-text-3 mb-1">Currency</label>
          <input
            type="text"
            value={form.comp_currency}
            onChange={set('comp_currency')}
            placeholder="EUR"
            className="w-full px-3 h-9 bg-bg-base border border-border-default focus:border-accent focus:outline-none rounded-md text-body text-text-1 placeholder:text-text-4 transition-colors"
          />
        </div>
      </div>

      <div className="flex justify-end pt-2">
        <button
          onClick={handleSave}
          disabled={!canSave || saving || saved}
          className="flex items-center gap-2 px-4 py-2 bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 text-white rounded-md transition-all font-medium text-body"
        >
          {saved ? <CheckCircle2 size={15} /> : null}
          {saved ? 'Saved!' : saving ? 'Saving…' : 'Save profile'}
        </button>
      </div>
    </div>
  )
}
