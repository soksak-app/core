#[cfg(test)]
mod fixture {
    #[test]
    fn never_built() {
        let value: u32 = "text";
        assert_eq!(value, 0);
    }
}
