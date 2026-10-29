// Plain-replace setters of `SettingsStore`, moved out of `settings.rs` unchanged (issue #1258,
// the #806 600-line cap). A child module of `settings.rs`, so it reads the store's private fields.
use super::{
    clamp_pull_requests_list_width_px, ChatWidth, HolidayTouches, SessionListCollapse, Settings,
    SettingsStore,
};

impl SettingsStore {
    pub async fn set_chat_width(&mut self, width: ChatWidth) -> std::io::Result<Settings> {
        let next = Settings {
            chat_width: width,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setHolidayTouches(value)` (issue #1048): plain-replace shape, as `set_chat_width`
    /// above uses -- no raw/lazy-correction tracking needed.
    pub async fn set_holiday_touches(
        &mut self,
        value: HolidayTouches,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            holiday_touches: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setDetectImagePathsOnPaste(enabled)` (#514): no raw/lazy-correction tracking
    /// needed, the same plain-boolean migration shape `set_transcript_display` above uses.
    pub async fn set_detect_image_paths_on_paste(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            detect_image_paths_on_paste: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setWordPredictionEnabled(enabled)` (issue #772, lane R6): no raw/lazy-correction
    /// tracking needed, the same plain-boolean migration shape `set_detect_image_paths_on_paste`
    /// above uses.
    pub async fn set_word_prediction_enabled(
        &mut self,
        enabled: bool,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            word_prediction_enabled: enabled,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setSessionListCollapse(value)` (#735, data-model.md): persists the whole
    /// `SessionListCollapse` row -- the renderer's `session-list-store.ts` is the sole writer
    /// and never reads a broadcast back (its own doc comment explains why), so there is no
    /// raw/lazy-correction tracking here, the same plain-replace shape `set_split` uses.
    pub async fn set_session_list_collapse(
        &mut self,
        value: SessionListCollapse,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            session_list_collapse: value,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// `settings.setPullRequestsListWidth(px)` (#930): plain-replace shape, as `set_split` uses.
    pub async fn set_pull_requests_list_width_px(
        &mut self,
        width_px: i64,
    ) -> std::io::Result<Settings> {
        let next = Settings {
            pull_requests_list_width_px: clamp_pull_requests_list_width_px(width_px),
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }
}
