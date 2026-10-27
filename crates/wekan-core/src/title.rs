use thiserror::Error;

pub const TITLE_MAX: usize = 200;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum TitleError {
    #[error("タイトルが空です")]
    Empty,
    #[error("タイトルは{TITLE_MAX}文字までです")]
    TooLong,
}

pub fn validate_title(title: &str) -> Result<(), TitleError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(TitleError::Empty);
    }
    if trimmed.chars().count() > TITLE_MAX {
        return Err(TitleError::TooLong);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_title() {
        validate_title(" Inbox ").unwrap();
    }

    #[test]
    fn rejects_blank() {
        assert_eq!(validate_title("   "), Err(TitleError::Empty));
        assert_eq!(validate_title(""), Err(TitleError::Empty));
    }

    #[test]
    fn rejects_too_long() {
        let long: String = "あ".repeat(TITLE_MAX + 1);
        assert_eq!(validate_title(&long), Err(TitleError::TooLong));
        validate_title(&"a".repeat(TITLE_MAX)).unwrap();
    }
}
