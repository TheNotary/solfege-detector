class Sayer:
    greeting: str

    # Here's a constructor in Python
    def __init__(self, greeting = "Hi"):
        self.greeting = greeting

    def say_hi(self):
        return self.greeting

    def say_bye(self):
        # Here's a word 'pass' which we use as filler for functions we haven't implemented yet
        pass
