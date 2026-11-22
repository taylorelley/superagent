// Synthetic fixture. All inputs and observable outputs are Boolean.
fn next_inhibit(inhibited: bool, fault: bool, reset: bool) -> bool {
    fault || (inhibited && !reset)
}

fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    match args.as_slice() {
        [mode] if mode == "exhaustive" => {
            for inhibited in [false, true] {
                for fault in [false, true] {
                    for reset in [false, true] {
                        let expected = match (fault, reset) {
                            (true, _) => true,
                            (false, true) => false,
                            (false, false) => inhibited,
                        };
                        assert_eq!(next_inhibit(inhibited, fault, reset), expected);
                        println!("inhibited={inhibited} fault={fault} reset={reset}: {expected}");
                    }
                }
            }
        }
        [mode] if mode == "scenario" => {
            assert!(next_inhibit(true, true, true));
            println!("RESET requested during active fault: INHIBITED");
            assert!(!next_inhibit(true, false, true));
            println!("RESET requested after fault clearance: ENABLED");
        }
        _ => {
            eprintln!("usage: interlock exhaustive|scenario");
            std::process::exit(2);
        }
    }
}
