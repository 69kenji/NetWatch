import { useEffect, useState } from 'react'

export function ProfileAvatar({ profile, size = 36 }: { profile: NetWatchProfileSummary; size?: number }) {
  const [image, setImage] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    setImage(null)
    if (!profile.avatar.startsWith('image:')) return
    void window.electron?.profiles.avatar(profile.id).then(result => { if (active) setImage(result.data) })
    return () => { active = false }
  }, [profile.avatar, profile.id])
  return <span className={`nw-profile-avatar is-${profile.avatar.replace(':', '-')}`} style={{ width: size, height: size }} aria-hidden="true">
    {image ? <img src={image} alt="" /> : <img className="nw-profile-avatar__mark" src="netwatch-icon.png" alt="" draggable={false} />}
  </span>
}
