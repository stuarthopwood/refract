// Composer menu spelling suggestions (#1431): WebView2 gives page script no suggestions, so the
// Windows Spell Checking API supplies them for the word under the caret.

use serde_json::Value;

use super::{invalid_argument, AppState, Dispatcher, HandlerFuture, IpcError};

pub fn register(d: &mut Dispatcher) {
    d.register("spellcheck.suggest", spellcheck_suggest);
    d.register("spellcheck.add", spellcheck_add);
}

const MAX_WORD_CHARS: usize = 64;
const MAX_SUGGESTIONS: usize = 5;

fn word_and_language(args: &[Value], method: &str) -> Result<(String, String), IpcError> {
    let word = args.first().and_then(Value::as_str).map(str::trim);
    let language = args.get(1).and_then(Value::as_str).map(str::trim);
    match (word, language) {
        (Some(word), Some(language))
            if !word.is_empty()
                && word.chars().count() <= MAX_WORD_CHARS
                && !word.chars().any(|c| c.is_whitespace() || c.is_control())
                && !language.is_empty()
                && language.len() <= 35
                && language
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-') =>
        {
            Ok((word.to_string(), language.to_string()))
        }
        _ => Err(invalid_argument(format!(
            "{method} expects a single word and a language tag"
        ))),
    }
}

fn spellcheck_suggest(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (word, language) = word_and_language(&args, "spellcheck.suggest")?;
        let (misspelt, suggestions) =
            tokio::task::spawn_blocking(move || platform::suggest(&word, &language))
                .await
                .map_err(|err| IpcError::new("spellcheck-failed", err.to_string()))?
                .map_err(|message| IpcError::new("spellcheck-failed", message))?;
        Ok(serde_json::json!({ "misspelt": misspelt, "suggestions": suggestions }))
    })
}

fn spellcheck_add(_state: AppState, args: Vec<Value>) -> HandlerFuture {
    Box::pin(async move {
        let (word, language) = word_and_language(&args, "spellcheck.add")?;
        tokio::task::spawn_blocking(move || platform::add(&word, &language))
            .await
            .map_err(|err| IpcError::new("spellcheck-failed", err.to_string()))?
            .map_err(|message| IpcError::new("spellcheck-failed", message))?;
        Ok(Value::Null)
    })
}

#[cfg(target_os = "windows")]
mod platform {
    use windows::core::{HSTRING, PWSTR};
    use windows::Win32::Foundation::S_OK;
    use windows::Win32::Globalization::{
        ISpellChecker, ISpellCheckerFactory, ISpellingError, SpellCheckerFactory,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED,
    };

    use super::MAX_SUGGESTIONS;

    // Pool threads are reused, so every call balances its own COM init.
    struct ComScope(bool);
    impl ComScope {
        fn new() -> Self {
            Self(unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok())
        }
    }
    impl Drop for ComScope {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    // `None` for a language Windows has no dictionary for: no suggestions rather than an error.
    fn open(language: &str) -> Result<Option<ISpellChecker>, String> {
        let unavailable = |e: windows::core::Error| format!("Spell checking is unavailable: {e}");
        let factory: ISpellCheckerFactory =
            unsafe { CoCreateInstance(&SpellCheckerFactory, None, CLSCTX_INPROC_SERVER) }
                .map_err(unavailable)?;
        let tag = HSTRING::from(language);
        if !unsafe { factory.IsSupported(&tag) }.is_ok_and(|b| b.as_bool()) {
            return Ok(None);
        }
        unsafe { factory.CreateSpellChecker(&tag) }
            .map(Some)
            .map_err(unavailable)
    }

    pub fn suggest(word: &str, language: &str) -> Result<(bool, Vec<String>), String> {
        let _com = ComScope::new();
        let Some(checker) = open(language)? else {
            return Ok((false, Vec::new()));
        };
        let text = HSTRING::from(word);
        let errors = unsafe { checker.Check(&text) }.map_err(|e| e.to_string())?;
        // `Next` returns S_FALSE with no item when the word is spelled correctly.
        let mut first: Option<ISpellingError> = None;
        if unsafe { errors.Next(&mut first) } != S_OK || first.is_none() {
            return Ok((false, Vec::new()));
        }
        let list = unsafe { checker.Suggest(&text) }.map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        while out.len() < MAX_SUGGESTIONS {
            let mut item = [PWSTR::null()];
            let mut fetched = 0u32;
            let hr = unsafe { list.Next(&mut item, Some(&mut fetched)) };
            if hr != S_OK || fetched == 0 {
                break;
            }
            if let Ok(s) = unsafe { item[0].to_string() } {
                out.push(s);
            }
            unsafe { CoTaskMemFree(Some(item[0].0 as *const _)) };
        }
        Ok((true, out))
    }

    pub fn add(word: &str, language: &str) -> Result<(), String> {
        let _com = ComScope::new();
        match open(language)? {
            Some(checker) => {
                unsafe { checker.Add(&HSTRING::from(word)) }.map_err(|e| e.to_string())
            }
            None => Ok(()),
        }
    }
}
#[cfg(not(target_os = "windows"))]
mod platform {
    pub fn suggest(_word: &str, _language: &str) -> Result<(bool, Vec<String>), String> {
        Ok((false, Vec::new()))
    }
    pub fn add(_word: &str, _language: &str) -> Result<(), String> {
        Ok(())
    }
}
