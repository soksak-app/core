# Starts a child that exits at once and does not reap it, so the child stays a zombie while this program runs. The system sends SIGCHLD
# after it has made the child a zombie, so the program prints the process id of the child once that signal has arrived.
$| = 1;
my $ended = 0;
$SIG{CHLD} = sub { $ended = 1 };
my $child = fork();
die "fork: $!" unless defined $child;
exit 0 if $child == 0;
sleep 60 until $ended;
print "$child\n";
sleep 60;
