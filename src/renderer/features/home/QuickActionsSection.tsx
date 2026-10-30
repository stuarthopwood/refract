// Home's Quick actions row (#869): add a Project (local or clone, the existing flyout) and start
// a Session from a branch in the default Project, both through existing shared dialogs.
import { PlusIcon } from 'lucide-react'
import { ScreenSection } from '@/components/ScreenSection'
import { Button } from '@/components/ui/button'
import { AddProjectMenu } from '@/features/sessions/AddProjectMenu'
import { NewSessionDialog } from '@/features/sessions/NewSessionDialog'
import { useDefaultRepositoryId } from '@/lib/defaultRepository'
import { useRepositoriesStore } from '@/state'

export function QuickActionsSection() {
  const defaultId = useDefaultRepositoryId()
  const repository = useRepositoriesStore((state) => state.repositories.find((r) => r.id === defaultId))
  return (
    <ScreenSection title="Quick actions">
      <div className="flex flex-wrap items-center gap-2">
        <AddProjectMenu variant="toolbar" />
        {repository && (
          <NewSessionDialog
            repository={repository}
            trigger={
              <Button type="button" variant="outline" size="sm">
                <PlusIcon aria-hidden className="size-4" />
                New session in {repository.name}
              </Button>
            }
          />
        )}
      </div>
    </ScreenSection>
  )
}
