import { useTranslation } from '@/contexts/TranslationContext';
import { Modal, ModalActions } from '@/components/ui/Modal';

/**
 * The "unofficial app" notice: not affiliated with or endorsed by GuruShots, the trademark, the terms-of-use risk of
 * automated voting, and the update check that contacts GitHub. It has no close button, Escape or backdrop dismissal —
 * only the acknowledge button, which the page records in `noticeAcknowledgedVersion`.
 *
 * @param props.onAcknowledge - called when the user presses "I understand"
 */
export function UnofficialNoticeModal({ isOpen, onAcknowledge }: { isOpen: boolean; onAcknowledge: () => void }) {
    const { t } = useTranslation();
    return (
        <Modal isOpen={isOpen} title={t('notice.title')} size="md" showCloseButton={false}>
            <div className="space-y-3 text-sm">
                <p>{t('notice.unofficial')}</p>
                <p>{t('notice.trademark')}</p>
                <p className="font-medium">{t('notice.terms')}</p>
                <p>{t('notice.updates')}</p>
            </div>
            <ModalActions>
                <button type="button" className="btn btn-latvian btn-sm" onClick={onAcknowledge}>
                    {t('notice.acknowledge')}
                </button>
            </ModalActions>
        </Modal>
    );
}
