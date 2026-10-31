// Plain-replace setters of `SettingsStore`; child module of `settings.rs` for the size cap (#806).
use super::{
    clamp_pull_requests_list_width_px, ChatWidth, HolidayTouches, SessionListCollapse, Settings,
    SettingsStore,
};

impl SettingsStore {
    pub async fn set_custom_theme(&mut self, id: Option<String>) -> std::io::Result<Settings> {
        let next = Settings {
            custom_theme: id,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    pub async fn set_chat_width(&mut self, width: ChatWidth) -> std::io::Result<Settings> {
        let next = Settings {
            chat_width: width,
            ..self.data.clone()
        };
        self.persist_whole(next).await
    }

    /// Plain-replace setter (#1048).
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

    /// Plain boolean setter (#514).
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

    /// Plain boolean setter (#772).
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

    /// Persists the whole `SessionListCollapse` row; the renderer is its sole writer (#735).
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

    /// Plain-replace setter (#930).
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
