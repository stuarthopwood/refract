import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { initials } from '@/lib/initials'

interface UserAvatarProps {
  name: string
  /** A validated `data:image/png|jpeg` URL (spec 008); initials show when absent or when it fails to load. */
  src?: string
  size?: 'default' | 'xs'
  className?: string
}

// Decorative (#505): the name always sits beside it, so the image has no alt text and the whole
// avatar is hidden from assistive technology.
export function UserAvatar({ name, src, size = 'default', className }: UserAvatarProps) {
  return (
    <Avatar aria-hidden size={size} className={className}>
      {src && <AvatarImage src={src} alt="" />}
      <AvatarFallback>{initials(name)}</AvatarFallback>
    </Avatar>
  )
}
